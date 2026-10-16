import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTotp, makeUserKey, toBase64 } from '@1warden/crypto';
import type { FieldDescriptor, VaultItem } from '@1warden/vault';

type Listener = (request: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
const url = 'https://example.com/login';
const content = { id: 'onewarden-id', url, frameId: 0, documentId: 'login-document', tab: { id: 7 } as chrome.tabs.Tab };
const account = { serverUrl: 'https://vault.test', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1000 } };
const secret = 'password-must-stay-in-background';
let data: Record<string, unknown>;
let listener: Listener;
let currentUrl: string;
let injections: { target: unknown; args?: unknown[] }[];
let changeUrlOnRead: boolean;
let popupOpened: boolean;
let pageFields: FieldDescriptor[];
let documentMatches: boolean;

function item(id: string, uri = url, extra: Partial<VaultItem> = {}): VaultItem {
  return {
    id, name: `Account ${id}`, type: 'login', rawType: 1, nameFailed: false,
    notes: 'private notes', notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username: `${id}@example.com`, password: secret, uris: [{ uri, match: 3 }],
      totp: null, passwordRevisionDate: null, fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [],
    ...extra,
  };
}

function storage(initial: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(initial[key])]));
    },
    async set(values: Record<string, unknown>) { Object.assign(initial, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete initial[key]; },
    async clear() { for (const key of Object.keys(initial)) delete initial[key]; },
  };
}

const send = (request: unknown, sender: chrome.runtime.MessageSender = content) =>
  new Promise<any>((resolve) => listener(request, sender, resolve));

beforeEach(async () => {
  vi.resetModules();
  const key = makeUserKey();
  data = { '1warden.account': account, '1warden.session': {
    account, userKey: { encKey: toBase64(key.encKey), macKey: toBase64(key.macKey) },
    items: [item('a'), item('b'), item('unrelated', 'https://other.test/'),
      item('deleted', url, { deletedAt: '2026-01-01' }), item('archived', url, { archivedAt: '2026-01-01' })],
    folders: [], token: null, expiresAt: Date.now() + 900_000,
  } };
  currentUrl = url;
  injections = [];
  changeUrlOnRead = false;
  popupOpened = false;
  documentMatches = true;
  const field: FieldDescriptor = { type: 'text', name: '', id: '', autocomplete: 'username', placeholder: '',
    ariaLabel: '', labelText: '', isVisible: true, isDisabled: false, isReadOnly: false, value: '' };
  pageFields = [field, { ...field, type: 'password', autocomplete: 'current-password' }];
  vi.stubGlobal('chrome', {
    runtime: { id: 'onewarden-id', getURL: (path: string) => `chrome-extension://onewarden-id/${path}`,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } }, sendMessage: async () => {},
    },
    storage: { session: storage(data), local: storage({}) },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [], get: async (id: number) => ({ id, url: currentUrl }),
      onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, openPopup: async () => { popupOpened = true; } },
    scripting: { executeScript: async (injection: { target: unknown; args?: unknown[]; func?: Function }) => {
      injections.push(injection);
      if (injection.func?.name === 'credentialDocumentMatches') return [{ result: documentMatches }];
      if (injection.args) return [{ result: (injection.args[0] as { index: number }[]).map(({ index }) => ({ index, ok: true, verified: true })) }];
      if (changeUrlOnRead) currentUrl = 'https://other.test/';
      return [{ result: pageFields }];
    } },
  });
  await import('./background');
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('inline account chooser boundary', () => {
  it('times out a stalled document lookup and lets a new request succeed', async () => {
    vi.useFakeTimers();
    let release!: (value: chrome.scripting.InjectionResult<unknown>[]) => void;
    vi.spyOn(chrome.scripting, 'executeScript').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const request = { type: '1warden:inline-accounts', nonce: 'synthetic-document', documentUrl: url };
    const pending = send(request);
    await vi.advanceTimersByTimeAsync(4100);
    expect(await pending).toMatchObject({ error: expect.stringContaining('超时') });
    expect(await send(request)).toMatchObject({ unlocked: true, accounts: [{ id: 'a' }, { id: 'b' }] });
    release([{ result: true, frameId: 0, documentId: content.documentId }]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('does not return account data if locking overtakes an independent lookup', async () => {
    let release!: (value: chrome.scripting.InjectionResult<unknown>[]) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(chrome.scripting, 'executeScript').mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
    const pending = send({ type: '1warden:inline-accounts', nonce: 'synthetic-document', documentUrl: url });
    await waiting;
    await send({ type: '1warden:lock' }, { id: content.id, url: 'chrome-extension://onewarden-id/popup.html' });
    release([{ result: true, frameId: 0, documentId: content.documentId }]);
    expect(await pending).toMatchObject({ error: expect.any(String) });
  });

  it('answers account lookups while another page holds the fill queue', async () => {
    const original = chrome.scripting.executeScript;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(chrome.scripting, 'executeScript').mockImplementation(async (...args) => {
      if (args[0].target.tabId === 8) { started(); await resume; }
      return original(...args);
    });
    const filling = send({ type: '1warden:inline-fill', itemId: 'a' }, { ...content, tab: { id: 8 } as chrome.tabs.Tab });
    await waiting;
    try {
      expect(await Promise.race([
        send({ type: '1warden:inline-accounts', nonce: 'synthetic-document', documentUrl: url }),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 200)),
      ])).toMatchObject({ unlocked: true, accounts: [{ id: 'a' }, { id: 'b' }] });
    } finally { release(); await filling; }
  });

  it('uses the browser URL after same-document navigation, only with a matching isolated nonce', async () => {
    currentUrl = 'https://example.com/sessions/two-factor/app';
    (data['1warden.session'] as { items: VaultItem[] }).items[0]!.login!.uris = [{ uri: currentUrl, match: 3 }];
    expect(await send({ type: '1warden:inline-accounts', nonce: 'synthetic-document', documentUrl: currentUrl }))
      .toEqual({ unlocked: true, accounts: [{ id: 'a', title: 'Account a', username: 'a@example.com' }] });
    documentMatches = false;
    expect(await send({ type: '1warden:inline-accounts', nonce: 'synthetic-document', documentUrl: currentUrl }))
      .toMatchObject({ error: expect.any(String) });
  });

  it('rejects a chooser from an earlier route even if the document nonce still matches', async () => {
    currentUrl = 'https://example.com/other';
    expect(await send({ type: '1warden:inline-fill', itemId: 'a', nonce: 'synthetic-document', documentUrl: url }))
      .toMatchObject({ error: expect.any(String) });
    expect(injections).toEqual([]);
  });
  function seedOtp(): void {
    const items = (data['1warden.session'] as { items: VaultItem[] }).items;
    items[0]!.login!.totp = 'JBSWY3DPEHPK3PXP';
    items[1]!.customFields.push({ name: '一次性密码', value: 'JBSWY3DPEHPK3PXP', type: 1, linkedId: null });
    items.push(item('no-otp'), item('invalid-otp', url, { customFields: [{ name: 'otp', value: '!!!', type: 1, linkedId: null }] }));
    pageFields.push({ ...pageFields[0]!, autocomplete: 'one-time-code', id: 'app_totp', name: 'app_otp' });
  }

  it('previews current codes only for usable matching TOTP accounts, never passwords or seeds', async () => {
    seedOtp();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const code = await generateTotp('JBSWY3DPEHPK3PXP', now);
    const response = await send({ type: '1warden:inline-accounts', target: { index: 2, kind: 'totp' } });
    const otp = { code: code.code, period: 30, expiresAt: (Math.floor(now / 30_000) + 1) * 30_000 };
    expect(response).toEqual({
      unlocked: true, accounts: [
        { id: 'a', title: 'Account a', username: 'a@example.com', otp },
        { id: 'b', title: 'Account b', username: 'b@example.com', otp },
      ],
    });
    expect(JSON.stringify(response)).not.toContain('JBSWY3DPEHPK3PXP');
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('never previews codes from an ordinary account request or a stale OTP field', async () => {
    seedOtp();
    expect((await send({ type: '1warden:inline-accounts' })).accounts.every((entry: object) => !('otp' in entry))).toBe(true);
    expect(await send({ type: '1warden:inline-accounts', target: { index: 1, kind: 'totp' } }))
      .toMatchObject({ error: expect.any(String) });
  });

  it('refreshes an expired preview and fills a new code instead of trusting the displayed code', async () => {
    seedOtp();
    const initial = Math.floor(Date.now() / 30_000) * 30_000 + 29_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(initial);
    const request = { type: '1warden:inline-accounts', target: { index: 2, kind: 'totp' } };
    const previous = await send(request);
    clock.mockReturnValue(initial + 2000);
    const fresh = await generateTotp('JBSWY3DPEHPK3PXP', initial + 2000);
    const next = await send(request);
    expect(next.accounts[0].otp.code).toBe(fresh.code);
    expect(next.accounts[0].otp.expiresAt).toBe(previous.accounts[0].otp.expiresAt + 30_000);
    expect(await send({ type: '1warden:inline-fill', itemId: 'a', target: request.target, code: previous.accounts[0].otp.code })).toEqual({ ok: true });
    expect(injections.at(-1)?.args?.[0]).toMatchObject([{ index: 2, value: fresh.code }]);
  });

  it('fills only the selected OTP input, including custom-field TOTP', async () => {
    seedOtp();
    expect(await send({ type: '1warden:inline-fill', itemId: 'b', target: { index: 2, kind: 'totp' } })).toEqual({ ok: true });
    expect(injections.at(-1)?.args?.[0]).toMatchObject([{ index: 2, value: expect.stringMatching(/^\d{6}$/) }]);
  });

  it('rejects stale field roles and missing TOTP without injecting other credentials', async () => {
    seedOtp();
    expect(await send({ type: '1warden:inline-fill', itemId: 'a', target: { index: 1, kind: 'totp' } })).toMatchObject({ error: expect.any(String) });
    expect(await send({ type: '1warden:inline-fill', itemId: 'no-otp', target: { index: 2, kind: 'totp' } })).toMatchObject({ error: expect.any(String) });
    expect(injections.every(injection => !injection.args)).toBe(true);
  });
  it('returns only matching account display fields and ignores caller-supplied URL and tab', async () => {
    expect(await send({ type: '1warden:inline-accounts', url: 'https://other.test/', tabId: 999 })).toEqual({
      unlocked: true, accounts: [
        { id: 'a', title: 'Account a', username: 'a@example.com' },
        { id: 'b', title: 'Account b', username: 'b@example.com' },
      ],
    });
  });

  it('returns no accounts when the vault is locked', async () => {
    delete data['1warden.session'];
    expect(await send({ type: '1warden:inline-accounts' })).toEqual({ unlocked: false, accounts: [] });
    expect(await send({ type: '1warden:inline-fill', itemId: 'a' })).toMatchObject({ error: expect.any(String) });
    expect(injections).toEqual([]);
  });

  it('keeps an expired live session locked when the chooser retries its cancelled request', async () => {
    expect(await send({ type: '1warden:inline-accounts' })).toMatchObject({ unlocked: true });
    (data['1warden.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
    expect(await send({ type: '1warden:inline-accounts' })).toMatchObject({ error: expect.any(String) });
    expect(await send({ type: '1warden:inline-accounts' })).toEqual({ unlocked: false, accounts: [] });
    expect(data['1warden.session']).toBeUndefined();
  });

  it.each([
    { ...content, id: 'other-extension' },
    { ...content, frameId: 3 },
    { id: content.id, url: content.url, tab: content.tab },
    { id: 'onewarden-id', url: 'chrome-extension://onewarden-id/popup.html' },
  ])('rejects untrusted or non-top-frame inline requests', async (sender) => {
    for (const type of ['1warden:inline-accounts', '1warden:inline-fill', '1warden:inline-unlock']) {
      expect(await send({ type, itemId: 'a' }, sender)).toMatchObject({ error: expect.any(String) });
    }
    expect(popupOpened).toBe(false);
    expect(injections).toEqual([]);
  });

  it('rejects a stale sender after its tab navigates', async () => {
    currentUrl = 'https://other.test/';
    for (const type of ['1warden:inline-accounts', '1warden:inline-fill']) {
      expect(await send({ type, itemId: 'a' })).toMatchObject({ error: expect.any(String) });
    }
    expect(injections).toEqual([]);
  });

  it('refuses a nonmatching item even when its ID is known', async () => {
    expect(await send({ type: '1warden:inline-fill', itemId: 'unrelated' })).toMatchObject({ error: expect.any(String) });
    expect(injections).toEqual([]);
  });

  it('fills only the requesting document and returns no credential values', async () => {
    expect(await send({ type: '1warden:inline-fill', itemId: 'b', tabId: 999, url: 'https://other.test/' })).toEqual({ ok: true });
    expect(injections.at(-1)).toMatchObject({
      target: { tabId: 7, documentIds: ['login-document'] },
      args: [[{ index: 0, value: 'b@example.com' }, { index: 1, value: secret }], url],
    });
  });

  it('rechecks the browser URL after reading fields before sending credentials', async () => {
    changeUrlOnRead = true;
    expect(await send({ type: '1warden:inline-fill', itemId: 'a' })).toMatchObject({ error: expect.any(String) });
    expect(injections).toHaveLength(1);
    expect(injections[0]?.args).toBeUndefined();
  });

  it('opens the extension popup without exposing an unlock form to the page', async () => {
    expect(await send({ type: '1warden:inline-unlock' })).toEqual({ ok: true });
    expect(popupOpened).toBe(true);
  });

  it('explains the toolbar fallback when this browser cannot open the popup', async () => {
    (globalThis as any).chrome.action.openPopup = async () => { throw new Error('unsupported'); };
    const response = await send({ type: '1warden:inline-unlock' });
    expect(response).toMatchObject({ error: expect.stringContaining('工具栏') });
  });
});
