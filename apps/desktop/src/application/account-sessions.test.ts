import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHost, resetHost } from '@coffer/ui';
import { buildProfileItem, type VaultClient, type UserProfile } from '@coffer/vault';
import {
  concatBytes, deriveMasterKey, encryptBytes, encryptString, hashMasterPassword, makeUserKey, stretchMasterKey,
} from '@coffer/crypto';
import { createDesktopApplication } from './desktop';

const a = { serverUrl: 'https://one.example', email: 'same@example.com' };
const b = { serverUrl: 'https://two.example', email: 'same@example.com' };
const password = 'test-master-password';
const profileA: UserProfile = { displayName: 'Account A', avatarDataUrl: null };
const profileB: UserProfile = { displayName: 'Account B', avatarDataUrl: null };
const clients = new Set<VaultClient>();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function setup() {
  const data = new Map<string, { wrapped: string; hash: string; ciphers: unknown[] }>();
  for (const [target, label, profile] of [[a, 'A', profileA], [b, 'B', profileB]] as const) {
    const key = makeUserKey();
    const masterKey = await deriveMasterKey(password, target.email, { kdf: 0, iterations: 1000 });
    const profileItem = buildProfileItem(profile);
    data.set(target.serverUrl, {
      wrapped: await encryptBytes(concatBytes(key.encKey, key.macKey), await stretchMasterKey(masterKey)),
      hash: await hashMasterPassword(masterKey, password),
      ciphers: [
        { id: `note-${label}`, type: 2, name: await encryptString(`Note ${label}`, key),
          notes: await encryptString(`Secret ${label}`, key), secureNote: { type: 0 } },
        { id: `profile-${label}`, type: 2, name: await encryptString(profileItem.name, key),
          notes: await encryptString(profileItem.notes!, key), secureNote: { type: 0 },
          fields: await Promise.all(profileItem.customFields.map(async (field) => ({ ...field,
            name: await encryptString(field.name, key), value: await encryptString(field.value, key),
          }))) },
      ],
    });
  }
  const storage = new Map<string, string>();
  const requests: string[] = [];
  const authentications: string[] = [];
  const twoFactor = new Set<string>();
  let waitForAuth: { origin: string; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  installHost({ storage: { get: async (key) => storage.get(key) ?? null,
    set: async (key, value) => { storage.set(key, value); }, remove: async (key) => { storage.delete(key); } },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(String(input));
      const account = data.get(url.origin);
      if (!account) throw Error('Unknown backend');
      switch (url.pathname) {
        case '/identity/accounts/prelogin': return Response.json({ kdf: 0, kdfIterations: 1000 });
        case '/identity/connect/token': {
          const body = new URLSearchParams(String(init?.body));
          authentications.push(JSON.stringify([url.origin, body.get('username')]));
          if (waitForAuth?.origin === url.origin) { waitForAuth.started.resolve(); await waitForAuth.release.promise; }
          if (body.get('password') !== account.hash) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          if (twoFactor.has(url.origin)) {
            if (!body.has('twoFactorToken')) return Response.json({ TwoFactorProviders: ['0'], TwoFactorProviders2: { '0': null } }, { status: 400 });
            if (body.get('twoFactorToken') !== '123456') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          return Response.json({ access_token: `e30.${btoa(JSON.stringify({ sub: url.hostname }))}.test`,
            expires_in: 3600, Key: account.wrapped, Kdf: 0 });
        }
        case '/api/accounts/revision-date': return new Response('1');
        case '/api/sync': return Response.json({ profile: { id: url.hostname, email: a.email },
          ciphers: account.ciphers, folders: [], collections: [] });
        default: throw Error(`Unexpected request: ${url.pathname}`);
      }
    },
  });
  const runtime = createDesktopApplication();
  const active = () => { clients.add(runtime.vault); return runtime.vault; };
  active();
  await runtime.client.initialize();
  const connect = async (target: typeof a) => {
    await runtime.client.connect({ ...target, masterPassword: password }); active();
  };
  return { runtime, app: runtime.client, active, connect, requests, authentications, storage,
    pauseAuthentication(origin: string) {
      waitForAuth = { origin, started: deferred(), release: deferred() }; return waitForAuth;
    },
    requireTwoFactor: (origin: string) => { twoFactor.add(origin); },
  };
}

beforeEach(() => {
  resetHost();
  vi.stubGlobal('localStorage', { getItem: () => 'account-session-test-device', setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const client of clients) client.logout();
  clients.clear(); resetHost(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('desktop retained account sessions', () => {
  it('prepares the Add Account origin draft before switching publishes the connection screen', async () => {
    const { app, active, connect } = await setup();
    await connect(a);
    const switching = app.switchAccount(null);
    const immediate = await app.connectionDraft?.load();
    await switching; active();
    expect(immediate).toEqual({ serverUrl: '', email: '', error: null, returnAccount: a });
  });

  it('resets the origin draft before returning to a selected account', async () => {
    const { app, active, connect } = await setup();
    await connect(a); await app.switchAccount(null); active();
    const switching = app.switchAccount(a);
    const immediate = await app.connectionDraft?.load();
    await switching;
    expect(immediate).toBeNull();
    expect(app.getSnapshot().status).toBe('unlocked');
  });

  it('rejects an invalid target without replacing the draft or publishing a connection screen', async () => {
    const { app, active, connect } = await setup();
    await connect(a); await app.switchAccount(null); active();
    await app.connectionDraft?.save({ serverUrl: b.serverUrl, email: b.email, error: 'failed' });
    const previous = await app.connectionDraft?.load();
    const publications: string[] = [];
    const unsubscribe = app.subscribe(() => { publications.push(app.getSnapshot().status); });
    await expect(app.switchAccount({ serverUrl: 'file:///invalid', email: a.email })).rejects.toThrow();
    unsubscribe();
    expect(await app.connectionDraft?.load()).toEqual(previous);
    expect(publications).toEqual([]);
  });

  it('clears a generic logged-out form instead of persisting an empty Add Account draft', async () => {
    const { app } = await setup();
    await app.connectionDraft?.save({ serverUrl: b.serverUrl, email: b.email, error: 'failed' });
    await app.switchAccount(null);
    expect(app.getSnapshot().status).toBe('loggedOut');
    expect(await app.connectionDraft?.load()).toBeNull();
  });

  it('returns A → B → A directly with isolated records and no new network requests', async () => {
    const { app, active, connect, requests } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey();
    await app.switchAccount(b); active();
    expect(app.getSnapshot().status).toBe('locked');
    await app.unlock(password); const vaultB = active();
    const count = requests.length;
    await app.switchAccount({ serverUrl: 'HTTPS://ONE.EXAMPLE/', email: ' SAME@EXAMPLE.COM ' });
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(app.getSnapshot().items.map((item) => item.id)).toEqual(['note-A']);
    expect(app.getSnapshot().profile).toEqual(profileA);
    expect(active()).toBe(vaultA);
    expect(vaultA.getSession().getKey()).toBe(keyA);
    expect(vaultB.getSession().isUnlocked()).toBe(true);
    expect(requests).toHaveLength(count);
    expect(app.getSnapshot().unlockedAccounts?.sort()).toEqual([
      '["https://one.example","same@example.com"]', '["https://two.example","same@example.com"]',
    ]);
  });

  it('parks A for Add Account, then returns after a failed new connection', async () => {
    const { app, active, connect, requests } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey();
    await app.switchAccount(null); const addition = active();
    expect(app.getSnapshot().status).toBe('loggedOut');
    expect(await app.connectionDraft?.load()).toEqual({ serverUrl: '', email: '', error: null, returnAccount: a });
    expect(addition).not.toBe(vaultA);
    await expect(app.connect({ ...b, masterPassword: 'wrong' })).rejects.toThrow();
    expect(app.getSnapshot().account).toBeNull();
    expect(vaultA.getSession().getKey()).toBe(keyA);
    await app.connectionDraft?.save({ serverUrl: b.serverUrl, email: b.email, error: 'failed' });
    expect((await app.connectionDraft?.load())?.returnAccount).toEqual(a);
    const count = requests.length;
    await app.switchAccount(a);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(requests).toHaveLength(count);
  });

  it('lock and logout wipe only the selected key and require server authentication on reentry', async () => {
    const { app, active, connect, authentications, storage } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey()!;
    await app.switchAccount(b); await app.unlock(password); const vaultB = active(); const keyB = vaultB.getSession().getKey()!;
    await app.lock();
    expect([...keyB.encKey, ...keyB.macKey].every((byte) => byte === 0)).toBe(true);
    expect(vaultA.getSession().getKey()).toBe(keyA);
    await app.switchAccount(a); await app.switchAccount(b);
    expect(app.getSnapshot().status).toBe('locked');
    await expect(app.unlock('wrong')).rejects.toThrow();
    expect(vaultB.getSession().getKey()).toBeNull();
    const count = authentications.length;
    await app.unlock(password);
    expect(authentications).toHaveLength(count + 1);
    const newKeyB = vaultB.getSession().getKey()!;
    await app.logout();
    expect([...newKeyB.encKey, ...newKeyB.macKey].every((byte) => byte === 0)).toBe(true);
    expect(storage.has('profile.v1.["https://two.example","same@example.com"]')).toBe(false);
    expect(storage.has('profile.v1.["https://one.example","same@example.com"]')).toBe(true);
    await app.switchAccount(a);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(vaultA.getSession().getKey()).toBe(keyA);
    await app.switchAccount(b);
    expect(app.getSnapshot().status).toBe('locked');
    expect(app.getSnapshot().profile).toBeNull();
    const afterLogout = authentications.length;
    await app.unlock(password);
    expect(authentications).toHaveLength(afterLogout + 1);
  });

  it('preserves an existing live session when an explicit connection to that identity fails', async () => {
    const { app, active, connect } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey();
    await expect(app.connect({ ...a, masterPassword: 'wrong' })).rejects.toThrow();
    expect(active()).toBe(vaultA);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(app.getSnapshot().profileReady).toBe(true);
    expect(vaultA.getSession().getKey()).toBe(keyA);
    expect(app.getSnapshot().items.map((item) => item.id)).toEqual(['note-A']);
  });

  it('authenticates a new account directly while preserving the previously selected session', async () => {
    const { app, active, connect } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey();
    await connect(b);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(app.getSnapshot().account?.serverUrl).toBe(b.serverUrl);
    expect(vaultA.getSession().getKey()).toBe(keyA);
    await app.switchAccount(a);
    expect(active()).toBe(vaultA);
  });

  it('does not activate a late new connection after the user returns to a retained account', async () => {
    const { app, active, connect, pauseAuthentication } = await setup();
    await connect(a); const vaultA = active();
    await app.switchAccount(null); active();
    const paused = pauseAuthentication(b.serverUrl);
    const connecting = app.connect({ ...b, masterPassword: password }).catch((error: unknown) => error);
    await paused.started.promise;
    await app.switchAccount(a);
    paused.release.resolve();
    expect(await connecting).toBeInstanceOf(Error);
    expect(active()).toBe(vaultA);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(app.getSnapshot().account?.serverUrl).toBe(a.serverUrl);
    expect(app.getSnapshot().unlockedAccounts).toEqual(['["https://one.example","same@example.com"]']);
  });

  it('keeps the parked account auto-lock deadline and publishes its locked state', async () => {
    const { app, active, connect } = await setup();
    vi.useFakeTimers();
    await connect(a); const vaultA = active();
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    await app.switchAccount(null); active();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await app.refresh();
    expect(vaultA.getSession().status).toBe('locked');
    expect(app.getSnapshot().unlockedAccounts).toEqual([]);
    await app.switchAccount(a);
    expect(app.getSnapshot().status).toBe('locked');
  });

  it('keeps a new OTP challenge separate and cancels it when returning to another account', async () => {
    const { app, active, connect, requireTwoFactor } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey();
    requireTwoFactor(b.serverUrl);
    await app.switchAccount(null); active();
    await expect(app.connect({ ...b, masterPassword: password })).rejects.toMatchObject({ kind: 'twoFactorRequired' });
    expect(app.getSnapshot().status).toBe('loggedOut');
    expect(vaultA.getSession().getKey()).toBe(keyA);
    await app.switchAccount(a);
    await expect(app.connectWithTwoFactor('123456', 0, false)).rejects.toMatchObject({ kind: 'authRestartRequired' });
    expect(active()).toBe(vaultA);
    expect(app.getSnapshot().status).toBe('unlocked');
    await app.switchAccount(null); active();
    await expect(app.connect({ ...b, masterPassword: password })).rejects.toMatchObject({ kind: 'twoFactorRequired' });
    await expect(app.connectWithTwoFactor('000000', 0, false)).rejects.toThrow();
    await app.connectWithTwoFactor('123456', 0, false); active();
    expect(app.getSnapshot().account?.serverUrl).toBe(b.serverUrl);
    expect(app.getSnapshot().status).toBe('unlocked');
    expect(vaultA.getSession().getKey()).toBe(keyA);
  });

  it('cancels UI secret reads during a switch while retaining the original session', async () => {
    const { app, active, connect, storage } = await setup();
    await connect(a); const vaultA = active(); const keyA = vaultA.getSession().getKey()!;
    const reading = app.getDraft('note-A').catch((error: unknown) => error);
    await app.switchAccount(b); active();
    expect(await reading).toBeInstanceOf(Error);
    expect(vaultA.getSession().getKey()).toBe(keyA);
    const disk = JSON.stringify([...storage]);
    expect(disk).not.toContain(password);
    expect(disk).not.toContain('Secret A');
    expect(disk).not.toContain(JSON.stringify([...keyA.encKey]));
    expect(disk).not.toContain(JSON.stringify([...keyA.macKey]));
  });
});
