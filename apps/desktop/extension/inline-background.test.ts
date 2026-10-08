import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUserKey, toBase64 } from '@1warden/crypto';
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
  vi.stubGlobal('chrome', {
    runtime: { id: 'onewarden-id', getURL: (path: string) => `chrome-extension://onewarden-id/${path}`,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } }, sendMessage: async () => {},
    },
    storage: { session: storage(data), local: storage({}) },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [], get: async (id: number) => ({ id, url: currentUrl }),
      onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, openPopup: async () => { popupOpened = true; } },
    scripting: { executeScript: async (injection: { target: unknown; args?: unknown[] }) => {
      injections.push(injection);
      if (injection.args) return [{ result: [{ index: 0, ok: true, verified: true }, { index: 1, ok: true, verified: true }] }];
      if (changeUrlOnRead) currentUrl = 'https://other.test/';
      const field: FieldDescriptor = { type: 'text', name: '', id: '', autocomplete: 'username', placeholder: '',
        ariaLabel: '', labelText: '', isVisible: true, isDisabled: false, isReadOnly: false, value: '' };
      return [{ result: [field, { ...field, type: 'password', autocomplete: 'current-password' }] }];
    } },
  });
  await import('./background');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('inline account chooser boundary', () => {
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
