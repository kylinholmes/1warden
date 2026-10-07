import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concatBytes, deriveMasterKey, encryptBytes, makeUserKey, stretchMasterKey, toBase64 } from '@coffer/crypto';

type Listener = (request: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
const account = { serverUrl: 'https://vault.test', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0 as const, iterations: 1000 } };
let data: Record<string, unknown>;
let listener: Listener;
let alarm: (event: { name: string }) => void;
let notices: unknown[];

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

const page = { id: 'coffer-id', url: 'chrome-extension://coffer-id/popup.html' };
const send = (request: unknown, sender: chrome.runtime.MessageSender = page) => new Promise<any>((resolve) => listener(request, sender, resolve));

beforeEach(async () => {
  vi.resetModules();
  const key = makeUserKey();
  data = { 'coffer.account': account, 'coffer.session': {
    account, userKey: { encKey: toBase64(key.encKey), macKey: toBase64(key.macKey) },
    items: [], folders: [], token: null, expiresAt: Date.now() + 900_000,
  } };
  notices = [];
  vi.stubGlobal('chrome', {
    runtime: { id: 'coffer-id', getURL: (path: string) => `chrome-extension://coffer-id/${path}`,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } },
      sendMessage: async (message: unknown) => { notices.push(structuredClone({ message, data })); },
    },
    storage: { session: storage(data), local: storage({}) },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } } },
    tabs: { query: async () => [], onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    action: { setBadgeText: async () => {} },
  });
  await import('./background');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('background application boundary', () => {
  it.each(['lock', 'logout'] as const)('%s as the first worker request clears the stored active account without restoring keys', async (method) => {
    const other = { ...account, serverUrl: 'https://other.test', userId: 'u2' };
    data['coffer.sessions'] = { '["https://other.test","a@b.com"]': {
      ...structuredClone(data['coffer.session'] as object), account: other,
    } };
    const profileKey = 'profile.v1.["https://vault.test","a@b.com"]';
    const otherProfileKey = 'profile.v1.["https://other.test","a@b.com"]';
    await chrome.storage.local.set({
      [profileKey]: JSON.stringify({ displayName: 'Account A', avatarDataUrl: null }),
      [otherProfileKey]: JSON.stringify({ displayName: 'Account B', avatarDataUrl: null }),
    });
    const restore = vi.spyOn((await import('@coffer/vault')).VaultClient.prototype, 'restore');
    try {
      expect(await send({ type: 'coffer:application', method, args: [] })).toMatchObject({ ok: true });
      expect(restore).not.toHaveBeenCalled();
      expect(data['coffer.session']).toBeUndefined();
      expect(Object.keys(data['coffer.sessions'] as object)).toEqual(['["https://other.test","a@b.com"]']);
      const profiles = await chrome.storage.local.get([profileKey, otherProfileKey]);
      expect(profiles[profileKey] === undefined).toBe(method === 'logout');
      expect(profiles[otherProfileKey]).toContain('Account B');
      expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
        ok: true, result: { status: method === 'lock' ? 'locked' : 'loggedOut' },
      });
      await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
      expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
        ok: true, result: { status: 'locked', account: { serverUrl: account.serverUrl, email: account.email } },
      });
      await send({ type: 'coffer:application', method: 'switchAccount', args: [other] });
      expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
        ok: true, result: { status: 'unlocked', account: other },
      });
    } finally { restore.mockRestore(); }
  });

  it.each(['lock', 'logout'] as const)('preserves parked accounts when %s interrupts an intentional Add Account selection', async (method) => {
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const deadline = (data['coffer.session'] as Record<string, unknown>)['expiresAt'];
    const get = chrome.storage.session.get.bind(chrome.storage.session);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    let pause = true;
    const reading = vi.spyOn(chrome.storage.session, 'get').mockImplementation(async (keys: any) => {
      const value = await get(keys);
      if (pause && Array.isArray(keys) && keys.length === 2) { pause = false; markStarted(); await paused; }
      return value;
    });
    const selecting = send({ type: 'coffer:application', method: 'switchAccount', args: [null] });
    await started;
    try {
      const clearing = send({ type: 'coffer:application', method, args: [] });
      finish();
      expect(await clearing).toMatchObject({ ok: true });
      expect(await selecting).toMatchObject({ ok: false });
      await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
      expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
        ok: true, result: { status: 'unlocked', account },
      });
      expect((data['coffer.session'] as Record<string, unknown>)['expiresAt']).toBe(deadline);
    } finally { finish(); reading.mockRestore(); }
  });

  it.each(['lock', 'logout'] as const)('preserves parked accounts when %s first wakes a worker with Add Account selected', async (method) => {
    await send({ type: 'coffer:application', method: 'switchAccount', args: [null] });
    vi.resetModules();
    await import('./background');
    expect(await send({ type: 'coffer:application', method, args: [] })).toMatchObject({ ok: true });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'unlocked', account },
    });
  });

  it.each(['lock', 'logout'] as const)('clears the newly selected account when %s interrupts storage selection', async (method) => {
    const other = { ...account, serverUrl: 'https://other.test', userId: 'u2' };
    data['coffer.sessions'] = { [JSON.stringify([other.serverUrl, other.email])]: { ...(data['coffer.session'] as object), account: other } };
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const get = chrome.storage.session.get.bind(chrome.storage.session);
    let finish!: () => void;
    let started!: () => void;
    let pause = true;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(chrome.storage.session, 'get').mockImplementation(async (keys: any) => {
      const value = await get(keys);
      if (pause && Array.isArray(keys) && keys.length === 2) {
        pause = false; started(); await new Promise<void>((resolve) => { finish = resolve; });
      }
      return value;
    });
    const selecting = send({ type: 'coffer:application', method: 'switchAccount', args: [other] });
    await waiting;
    const clearing = send({ type: 'coffer:application', method, args: [] });
    finish();
    expect(await clearing).toMatchObject({ ok: true });
    expect(await selecting).toMatchObject({ ok: false });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [other] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'locked' } });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'unlocked', account } });
  });
  it('can retry an account selection after a transient storage read failure', async () => {
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const get = chrome.storage.session.get.bind(chrome.storage.session);
    let fail = true;
    vi.spyOn(chrome.storage.session, 'get').mockImplementation(async (keys: any) => {
      if (fail && Array.isArray(keys) && keys.length === 2) { fail = false; throw new Error('Synthetic transient read failure'); }
      return get(keys);
    });
    expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [account] })).toMatchObject({ ok: false });
    expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [account] })).toMatchObject({ ok: true });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'unlocked' } });
  });
  it('parks Add Account and returns to an unlocked account without another authentication', async () => {
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const deadline = (data['coffer.session'] as Record<string, unknown>)['expiresAt'];
    expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [null] })).toMatchObject({ ok: true });
    expect(data['coffer.connectionDraft']).toMatchObject({ serverUrl: '', email: '', returnAccount: { serverUrl: account.serverUrl, email: account.email } });
    expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [account] })).toMatchObject({ ok: true });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'unlocked', account } });
    expect((data['coffer.session'] as Record<string, unknown>)['expiresAt']).toBe(deadline);
  });

  it('keeps different-backend sessions while clearing only the account that logs out', async () => {
    const other = { ...account, serverUrl: 'https://other.test', userId: 'u2' };
    data['coffer.sessions'] = { [JSON.stringify([other.serverUrl, other.email])]: { ...(data['coffer.session'] as object), account: other } };
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [other] })).toMatchObject({ ok: true });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'unlocked', account: other } });
    await send({ type: 'coffer:application', method: 'logout', args: [] });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [other] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'locked', account: { serverUrl: other.serverUrl, email: other.email } } });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'unlocked', account } });
  });

  it('locks an expired parked identity instead of silently extending its login', async () => {
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    await send({ type: 'coffer:application', method: 'switchAccount', args: [null] });
    const slots = data['coffer.sessions'] as Record<string, Record<string, unknown>>;
    slots[JSON.stringify([account.serverUrl, account.email])]!['expiresAt'] = Date.now() - 1;
    await send({ type: 'coffer:application', method: 'switchAccount', args: [account] });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({ ok: true, result: { status: 'locked', account: { serverUrl: account.serverUrl, email: account.email } } });
    expect(JSON.stringify(data['coffer.sessions'])).not.toContain('encKey');
  });
  it('coalesces concurrent snapshots during the initial stored-session restore', async () => {
    const area = chrome.storage.session;
    const get = area.get.bind(area);
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const reading = new Promise<void>((resolve) => { finish = resolve; });
    let reads = 0;
    vi.spyOn(area, 'get').mockImplementation(async (keys: any) => {
      if (keys === 'coffer.session') { reads++; markStarted(); await reading; }
      return get(keys);
    });
    const first = send({ type: 'coffer:application', method: 'snapshot', args: [] });
    await started;
    const second = send({ type: 'coffer:application', method: 'snapshot', args: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try { expect(reads).toBe(1); }
    finally { finish(); }
    expect(await first).toMatchObject({ ok: true, result: { status: 'unlocked' } });
    expect(await second).toMatchObject({ ok: true, result: { status: 'unlocked' } });
  });

  it.each(['sync', 'persistence'] as const)('reads a newly unlocked snapshot while initial %s is pending', async (boundary) => {
    await send({ type: 'coffer:application', method: 'logout', args: [] });
    const masterPassword = 'synthetic test password';
    const userKey = makeUserKey();
    const encryptedKey = await encryptBytes(concatBytes(userKey.encKey, userKey.macKey),
      await stretchMasterKey(await deriveMasterKey(masterPassword, account.email, account.kdf)));
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (boundary === 'sync' && path === '/api/sync') { markStarted(); await pending; }
      if (path === '/identity/accounts/prelogin') return Response.json({ kdf: 0, kdfIterations: 1000 });
      if (path === '/identity/connect/token') return Response.json({
        access_token: `header.${btoa(JSON.stringify({ sub: 'u1' }))}.signature`,
        refresh_token: 'test-refresh-token', expires_in: 3600, Key: encryptedKey,
      });
      if (path === '/api/accounts/revision-date') return new Response('1');
      if (path === '/api/sync') return Response.json({ profile: { id: 'u1', email: account.email }, folders: [], ciphers: [], collections: [] });
      throw new Error(`Unexpected test endpoint ${path}`);
    });
    if (boundary === 'persistence') {
      const area = chrome.storage.session;
      const set = area.set.bind(area);
      vi.spyOn(area, 'set').mockImplementation(async (values: Record<string, unknown>) => {
        if (values['coffer.session']) { markStarted(); await pending; }
        return set(values);
      });
    }
    const connecting = send({ type: 'coffer:application', method: 'connect', args: [{
      serverUrl: account.serverUrl, email: account.email, masterPassword,
    }] });
    await started;
    try {
      expect(data['coffer.session']).toBeUndefined();
      expect(await Promise.race([
        send({ type: 'coffer:application', method: 'snapshot', args: [] }),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).toMatchObject({ ok: true, result: { status: 'unlocked' } });
    } finally { finish(); }
    expect(await connecting).toMatchObject({ ok: true });
    expect(data['coffer.session']).toBeDefined();
    // Once login is durable, ordinary expiry checks must resume.
    (data['coffer.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'locked' },
    });
  });

  it('restores a session for the shared UI, then persists lock before sending its change notification', async () => {
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'unlocked', account, items: [] },
    });
    expect(await send({ type: 'coffer:application', method: 'lock', args: [] })).toMatchObject({ ok: true });
    expect(data['coffer.session']).toBeUndefined();
    expect(data['coffer.account']).toEqual(account);
    expect(notices).toContainEqual({ message: { type: 'coffer-internal:changed' }, data: { 'coffer.account': account } });
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'locked', items: [] },
    });
  });

  it('rejects content-script access to application operations before touching the stored session', async () => {
    const result = await send({ type: 'coffer:application', method: 'lock', args: [] },
      { id: 'coffer-id', url: 'https://example.com' });
    expect(result).toMatchObject({ ok: false });
    expect(data['coffer.session']).toBeDefined();
  });

  it('refuses expired plaintext on worker restore and keeps the account locked', async () => {
    (data['coffer.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'locked', items: [] },
    });
    expect(data['coffer.session']).toBeUndefined();
  });

  it('expires a live session during a stalled write before returning a snapshot', async () => {
    (data['coffer.session'] as Record<string, unknown>)['token'] = { accessToken: 'test-token' };
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let authenticationRequests = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith('/identity/')) {
        authenticationRequests++;
        return Response.json({ message: 'Synthetic authentication failure' }, { status: 401 });
      }
      const body = JSON.parse(String(init?.body)) as { name: string };
      await new Promise<void>((resolve) => { finish = resolve; markStarted(); });
      return Response.json({ id: 'late-folder', name: body.name, revisionDate: '2026-10-07' });
    });
    const writing = send({ type: 'coffer:application', method: 'createFolder', args: ['Late'] });
    await started;
    (data['coffer.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
    try {
      expect(await Promise.race([
        send({ type: 'coffer:application', method: 'snapshot', args: [] }),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).toMatchObject({ ok: true, result: { status: 'locked', folders: [] } });
      expect(data['coffer.session']).toBeUndefined();
      expect(await Promise.race([
        writing,
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).toMatchObject({ ok: false });
      expect(await Promise.race([
        send({ type: 'coffer:application', method: 'unlock', args: ['synthetic wrong password'] }),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).toMatchObject({ ok: false });
      expect(authenticationRequests).toBe(1);
    } finally { finish(); }
    expect(await writing).toMatchObject({ ok: false });
    expect(data['coffer.session']).toBeUndefined();
  });

  it('restores the transport and persists an encrypted folder write before notifying the UI', async () => {
    (data['coffer.session'] as Record<string, unknown>)['token'] = { accessToken: 'test-token' };
    const initialDeadline = (data['coffer.session'] as Record<string, unknown>)['expiresAt'];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://vault.test/api/folders');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as { name: string };
      expect(body.name).not.toBe('Work');
      return new Response(JSON.stringify({ id: 'new-folder', name: body.name, revisionDate: '2026-10-07' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const reply = await send({ type: 'coffer:application', method: 'createFolder', args: ['Work'] });
    expect(reply).toMatchObject({ ok: true });
    expect(data['coffer.session']).toMatchObject({ expiresAt: initialDeadline, folders: [{ id: 'new-folder', name: 'Work' }] });
    expect(notices).toContainEqual(expect.objectContaining({
      message: { type: 'coffer-internal:changed' },
      data: expect.objectContaining({ 'coffer.session': expect.objectContaining({ folders: [{ id: 'new-folder', name: 'Work', nameFailed: false, updatedAt: '2026-10-07' }] }) }),
    }));
  });

  it('an overdue alarm locks the live client and removes pending captured secrets', async () => {
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    data['coffer.pending'] = { '7': { password: 'captured-secret' } };
    (data['coffer.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
    alarm({ name: 'coffer:auto-lock' });
    // The alarm invalidates requests already in flight, then publishes the locked state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: 'locked' },
    });
    expect(data['coffer.session']).toBeUndefined();
    expect(data['coffer.pending']).toBeUndefined();
  });

  it('does not return another document’s cached passkey response after navigation in the same tab', async () => {
    data['coffer.webauthnDone'] = { '7:0:1': { ok: true, credentialId: 'old-site-credential' } };
    const response = await send({ type: 'coffer:webauthn', payload: {
      id: 1, op: 'get', rpId: 'example.com', challenge: 'AQ', allowCredentials: null, userVerification: 'required',
    } }, { id: 'coffer-id', url: 'https://other.test/', origin: 'https://other.test', frameId: 0,
      tab: { id: 7 } as chrome.tabs.Tab, documentId: 'new-document' });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain('old-site-credential');
  });

  it.each(['read', 'write'] as const)('keeps a retired account’s passkey result out of the new account during a pending cache %s', async (boundary) => {
    const other = { ...account, serverUrl: 'https://other.test', userId: 'u2' };
    data['coffer.sessions'] = { '["https://other.test","a@b.com"]': {
      ...structuredClone(data['coffer.session'] as object), account: other,
    } };
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const handler = vi.spyOn(await import('./webauthn'), 'handleWebauthn')
      .mockResolvedValueOnce({ ok: true, credentialId: 'account-a-credential' })
      .mockResolvedValueOnce({ ok: true, credentialId: 'account-b-credential' });
    const area = chrome.storage.session;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    let reads = 0;
    const get = area.get.bind(area);
    const set = area.set.bind(area);
    const reading = vi.spyOn(area, 'get').mockImplementation(async (keys: any) => {
      const value = await get(keys);
      if (boundary === 'read' && keys === 'coffer.webauthnDone' && ++reads === 2) { markStarted(); await paused; }
      return value;
    });
    const writing = vi.spyOn(area, 'set').mockImplementation(async (values: Record<string, unknown>) => {
      if (boundary === 'write' && values['coffer.webauthnDone']) { markStarted(); await paused; }
      return set(values);
    });
    const sender = { id: 'coffer-id', url: 'https://example.com/', origin: 'https://example.com', frameId: 0,
      tab: { id: 7 } as chrome.tabs.Tab, documentId: 'same-document' };
    const request = { type: 'coffer:webauthn', payload: { id: 1, op: 'get' } };
    const retiredRequest = send(request, sender);
    await started;
    try {
      const switching = send({ type: 'coffer:application', method: 'switchAccount', args: [other] });
      if (boundary === 'read') await switching;
      else await new Promise((resolve) => setTimeout(resolve, 0));
      finish();
      expect(await switching).toMatchObject({ ok: true });
      expect(await retiredRequest).toMatchObject({ error: expect.any(String) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(data['coffer.webauthnDone']).toBeUndefined();
      expect(await send(request, sender)).toMatchObject({ ok: true, credentialId: 'account-b-credential' });
    } finally { finish(); reading.mockRestore(); writing.mockRestore(); handler.mockRestore(); }
  });

  it.each(['claim', 'release'] as const)('keeps a retired account’s passkey %s from being recreated after account cleanup', async (boundary) => {
    const other = { ...account, serverUrl: 'https://other.test', userId: 'u2' };
    data['coffer.sessions'] = { '["https://other.test","a@b.com"]': {
      ...structuredClone(data['coffer.session'] as object), account: other,
    } };
    await send({ type: 'coffer:application', method: 'snapshot', args: [] });
    const handler = vi.spyOn(await import('./webauthn'), 'handleWebauthn')
      .mockResolvedValue({ ok: false, error: 'Synthetic passkey failure' });
    const area = chrome.storage.session;
    const get = area.get.bind(area);
    let reads = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    const reading = vi.spyOn(area, 'get').mockImplementation(async (keys: any) => {
      const value = await get(keys);
      if (keys === 'coffer.webauthnClaim' && ++reads === (boundary === 'claim' ? 1 : 3)) { markStarted(); await paused; }
      return value;
    });
    const retiredRequest = send({ type: 'coffer:webauthn', payload: { id: 1, op: 'get' } },
      { id: 'coffer-id', url: 'https://example.com/', origin: 'https://example.com', frameId: 0,
        tab: { id: 7 } as chrome.tabs.Tab, documentId: 'same-document' });
    await started;
    try {
      expect(await send({ type: 'coffer:application', method: 'switchAccount', args: [other] })).toMatchObject({ ok: true });
      finish();
      expect(await retiredRequest).toMatchObject({ error: expect.any(String) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(data['coffer.webauthnClaim']).toBeUndefined();
    } finally { finish(); reading.mockRestore(); handler.mockRestore(); }
  });

  it.each(['lock', 'logout', 'alarm'] as const)('%s cancels a hanging network write without restoring its later response', async (boundary) => {
    (data['coffer.session'] as Record<string, unknown>)['token'] = { accessToken: 'test-token' };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish!: () => void;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { name: string };
      await new Promise<void>((resolve) => { finish = resolve; markStarted(); });
      return new Response(JSON.stringify({ id: 'late-folder', name: body.name, revisionDate: '2026-10-07' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const writing = send({ type: 'coffer:application', method: 'createFolder', args: ['Late'] });
    await started;
    if (boundary === 'alarm') {
      (data['coffer.session'] as Record<string, unknown>)['expiresAt'] = Date.now() - 1;
      alarm({ name: 'coffer:auto-lock' });
    } else {
      void send({ type: 'coffer:application', method: boundary, args: [] });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(data['coffer.session']).toBeUndefined();
    const expectedStatus = boundary === 'logout' ? 'loggedOut' : 'locked';
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: expectedStatus, folders: [] },
    });
    finish();
    expect(await writing).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(data['coffer.session']).toBeUndefined();
    expect(await send({ type: 'coffer:application', method: 'snapshot', args: [] })).toMatchObject({
      ok: true, result: { status: expectedStatus, folders: [] },
    });
  });
});
