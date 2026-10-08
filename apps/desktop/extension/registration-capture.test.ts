import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUserKey, toBase64 } from '@1warden/crypto';
import type { VaultItem } from '@1warden/vault';

type Listener = (request: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
type Input = { type: string; autocomplete: string; value: string; name?: string };
const account = { serverUrl: 'https://vault.test', email: 'capture@example.test', userId: 'u1', kdf: { kdf: 0, iterations: 1000 } };
const url = 'https://signup.example.test/register';
const popup = { id: 'onewarden-id', url: 'chrome-extension://onewarden-id/popup.html' };
const content = { id: 'onewarden-id', url, frameId: 0, tab: { id: 7 } as chrome.tabs.Tab };
const username = 'new-account@example.test';
const newPassword = 'synthetic-new-password';
const oldPassword = 'synthetic-old-password';
let listener: Listener;
let data: Record<string, unknown>;
let inputs: Input[];
let reads: number;
let writes: { url: string; method: string | undefined; body: Record<string, unknown> }[];

function storage(values: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values[key])]));
    },
    async set(items: Record<string, unknown>) { Object.assign(values, structuredClone(items)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    async clear() { for (const key of Object.keys(values)) delete values[key]; },
  };
}

const send = (request: unknown, sender: chrome.runtime.MessageSender = popup) =>
  new Promise<any>((resolve) => listener(request, sender, resolve));

// Submission is a one-way content message. The subsequent popup request shares
// the real worker's serial queue, so it waits until capture has finished.
function submit() {
  listener({ type: '1warden:submitted', url: 'https://caller-supplied.test/' }, content, () => {});
  return send({ type: '1warden:pending', tabId: 7 });
}

function existingLogin(): VaultItem {
  return {
    id: 'existing', type: 'login', rawType: 1, name: 'Existing account', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '2026-10-01T00:00:00Z', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username, password: oldPassword, totp: null, uris: [{ uri: url, match: null }],
      passwordRevisionDate: null, fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [],
  };
}

beforeEach(async () => {
  vi.resetModules();
  const key = makeUserKey();
  data = { '1warden.account': account, '1warden.session': {
    account, userKey: { encKey: toBase64(key.encKey), macKey: toBase64(key.macKey) },
    items: [], folders: [], token: { accessToken: 'synthetic-token' }, expiresAt: Date.now() + 900_000,
  } };
  inputs = [
    { type: 'email', autocomplete: 'username', value: username },
    { type: 'password', autocomplete: 'new-password', value: newPassword },
    { type: 'password', autocomplete: 'new-password', name: 'confirm-password', value: 'different-confirmation-value' },
  ];
  reads = 0;
  writes = [];
  vi.stubGlobal('document', { querySelectorAll: () => inputs.map((input) => ({
    value: input.value, id: '', hidden: false, disabled: false, readOnly: false,
    getAttribute: (name: string) => name === 'type' ? input.type
      : name === 'autocomplete' ? input.autocomplete : name === 'name' ? input.name ?? '' : null,
    closest: () => null,
  })) });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block' }));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push({ url: String(input), method: init?.method, body });
    return Response.json({ ...body, id: 'existing', creationDate: '2026-10-09T00:00:00Z', revisionDate: '2026-10-09T00:00:00Z' });
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'onewarden-id', getURL: (path: string) => `chrome-extension://onewarden-id/${path}`,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } }, sendMessage: async () => {},
    },
    storage: { session: storage(data), local: storage({}) },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [], onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async (injection: { func: Function; args?: unknown[] }) => {
      reads++;
      // Match Chrome's serialized injection boundary, exercising production DOM
      // descriptors and readers rather than returning preclassified values.
      const detached = new Function(`return (${injection.func.toString()})`)() as Function;
      return [{ result: detached(...(injection.args ?? [])) }];
    } },
  });
  await import('./background');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('submitted credential capture', () => {
  it.each([true, false])('offers registration capture with username present=%s and saves only after confirmation', async (hasUsername) => {
    if (!hasUsername) inputs.shift();
    const pending = await submit();
    expect(pending).toEqual({ pending: { url, username: hasUsername ? username : null, action: 'save', itemId: null } });
    expect(JSON.stringify(pending)).not.toContain(newPassword);
    expect(writes).toEqual([]);
    expect(data['1warden.session']).toMatchObject({ items: [] });

    expect(await send({ type: '1warden:save-capture', tabId: 7 })).toEqual({ ok: true });
    expect(data['1warden.session']).toMatchObject({ items: [{ name: 'signup.example.test',
      login: { username: hasUsername ? username : null, password: newPassword, uris: [{ uri: url, match: null }] } }] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ url: 'https://vault.test/api/ciphers', method: 'POST' });
    expect(JSON.stringify(writes)).not.toContain(newPassword);
    expect(await send({ type: '1warden:pending', tabId: 7 })).toEqual({ pending: null });
  });

  it.each([2, 3])('captures the new password from a %s-password change form and keeps the old password in history', async (passwordCount) => {
    (data['1warden.session'] as { items: VaultItem[] }).items = [existingLogin()];
    inputs.splice(1, 0, { type: 'password', autocomplete: 'current-password', value: oldPassword });
    if (passwordCount === 2) inputs.pop();
    expect(await submit()).toEqual({ pending: { url, username, action: 'update', itemId: 'existing' } });
    expect(writes).toEqual([]);

    expect(await send({ type: '1warden:save-capture', tabId: 7 })).toEqual({ ok: true });
    expect(data['1warden.session']).toMatchObject({ items: [{ id: 'existing', login: { password: newPassword },
      passwordHistory: [{ password: oldPassword, lastUsedDate: expect.any(String) }] }] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ url: 'https://vault.test/api/ciphers/existing', method: 'PUT' });
  });

  it('still captures a single current-password login field', async () => {
    inputs = [inputs[0]!, { type: 'password', autocomplete: 'current-password', value: oldPassword }];
    expect(await submit()).toMatchObject({ pending: { action: 'save', username } });
    expect(await send({ type: '1warden:save-capture', tabId: 7 })).toEqual({ ok: true });
    expect(data['1warden.session']).toMatchObject({ items: [{ login: { password: oldPassword } }] });
  });

  it.each(['', '   ', '********'])('does not capture an empty or placeholder new password (%j) or fall back to the old one', async (value) => {
    inputs[1]!.value = value;
    inputs.splice(1, 0, { type: 'password', autocomplete: 'current-password', value: oldPassword });
    expect(await submit()).toEqual({ pending: null });
    expect(writes).toEqual([]);
  });

  it('does not read fields or capture credentials while the vault is locked', async () => {
    delete data['1warden.session'];
    expect(await submit()).toEqual({ pending: null });
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
  });

  it('requires the trusted popup to confirm capture and clears it on dismiss', async () => {
    expect(await submit()).toMatchObject({ pending: { action: 'save' } });
    expect(await send({ type: '1warden:save-capture', tabId: 7 }, content)).toMatchObject({ error: expect.any(String) });
    expect(writes).toEqual([]);
    expect(await send({ type: '1warden:dismiss-capture', tabId: 7 })).toEqual({ ok: true });
    expect(await send({ type: '1warden:pending', tabId: 7 })).toEqual({ pending: null });
  });

  it.each(['lock', 'switchAccount'] as const)('clears captured secrets at the %s boundary before a later save', async (method) => {
    expect(await submit()).toMatchObject({ pending: { action: 'save' } });
    const args = method === 'lock' ? [] : [{ ...account, serverUrl: 'https://other-vault.test', email: 'other@example.test', userId: 'u2' }];
    expect(await send({ type: '1warden:application', method, args })).toMatchObject({ ok: true });
    expect(await send({ type: '1warden:pending', tabId: 7 })).toEqual({ pending: null });
    expect(await send({ type: '1warden:save-capture', tabId: 7 })).toMatchObject({ error: expect.any(String) });
    expect(writes).toEqual([]);
    expect(JSON.stringify(data)).not.toContain(newPassword);
  });
});
