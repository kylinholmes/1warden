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

async function submit() {
  const state = await send({ type: '1warden:credential-document', nonce: 'document-one' }, content);
  if (state.unlocked) {
    const password = inputs.find(i => i.autocomplete === 'new-password') ?? inputs.find(i => i.type === 'password');
    await send({ type: '1warden:credential-capture', nonce: 'document-one', token: state.token,
      input: { formId: 'form-one', username: inputs.find(i => i.type === 'email')?.value ?? null,
        password: password?.value ?? '', intent: inputs.some(i => i.autocomplete === 'new-password') ? 'signup' : 'login', submitted: true } }, content);
    return await send({ type: '1warden:credential-list' });
  }
  return [];
}
async function save(row: { id: string; revision: number; action: string; targets: { id: string; updatedAt: string }[] }) {
  const target = row.targets[0];
  return send({ type: '1warden:credential-save', application: true, choice: {
    captureId: row.id, revision: row.revision, action: target ? 'update' : 'save',
    ...(target ? { itemId: target.id, targetUpdatedAt: target.updatedAt } : {}),
  } });
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
    { type: 'password', autocomplete: 'new-password', name: 'confirm-password', value: newPassword },
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
    tabs: { query: async () => [], get: async () => ({ id: 7, url }), onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
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

describe('submitted credential capture through validated document grants', () => {
  it.each([true, false])('saves registration only after confirmation, username present=%s', async hasUsername => {
    if (!hasUsername) inputs.shift();
    const rows = await submit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url, username: hasUsername ? username : null, action: 'save' });
    expect(JSON.stringify(rows)).not.toContain(newPassword); expect(writes).toEqual([]);
    expect(await save(rows[0])).toEqual({ ok: true });
    expect(data['1warden.session']).toMatchObject({ items: [{ login: { username: hasUsername ? username : null, password: newPassword } }] });
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ url: 'https://vault.test/api/ciphers', method: 'POST' });
    expect(JSON.stringify(writes)).not.toContain(newPassword);
    expect(await send({ type: '1warden:credential-list' })).toEqual([]);
  });
  it('updates the chosen login and retains its previous password history', async () => {
    (data['1warden.session'] as { items: VaultItem[] }).items = [existingLogin()];
    const rows = await submit(); expect(rows[0]).toMatchObject({ action: 'review' });
    expect(await save(rows[0])).toEqual({ ok: true });
    expect(data['1warden.session']).toMatchObject({ items: [{ id: 'existing', login: { password: newPassword },
      passwordHistory: [{ password: oldPassword, lastUsedDate: expect.any(String) }] }] });
    expect(writes[0]).toMatchObject({ url: 'https://vault.test/api/ciphers/existing', method: 'PUT' });
  });
  it.each(['', '   ', '********'])('ignores empty and placeholder submissions (%j)', async value => {
    inputs[1]!.value = value; expect(await submit()).toEqual([]); expect(writes).toEqual([]);
  });
  it('grants no capture authority while locked', async () => {
    delete data['1warden.session']; expect(await submit()).toEqual([]); expect(reads).toBe(0); expect(writes).toEqual([]);
  });
  it('rejects the retired unbound capture APIs', async () => {
    for (const type of ['1warden:submitted', '1warden:save-capture', '1warden:pending']) {
      expect(await send({ type, tabId: 7 }, content)).toMatchObject({ error: expect.any(String) });
      expect(await send({ type, tabId: 7 })).toMatchObject({ error: expect.any(String) });
    }
    expect(reads).toBe(0); expect(writes).toEqual([]);
  });
  it.each(['lock', 'switchAccount'] as const)('clears secrets at the %s boundary', async method => {
    const rows = await submit(); expect(rows).toHaveLength(1);
    const args = method === 'lock' ? [] : [{ ...account, serverUrl: 'https://other-vault.test', email: 'other@example.test', userId: 'u2' }];
    expect(await send({ type: '1warden:application', method, args })).toMatchObject({ ok: true });
    expect(await save(rows[0])).toMatchObject({ ok: false });
    expect(data['1warden.credential-captures']).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(newPassword); expect(writes).toEqual([]);
  });
});
