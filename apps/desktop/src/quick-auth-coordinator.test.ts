import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installHost, resetHost } from '@1warden/ui';
import { concatBytes, deriveMasterKey, encryptBytes, hashMasterPassword, makeUserKey, stretchMasterKey } from '@1warden/crypto';
import type { VaultClient } from '@1warden/vault';
import { createDesktopApplication } from './application/desktop';
import { accountKey } from './application/account-target';
import { createQuickAuthCoordinator } from './quick-auth-coordinator';
import type { QuickAuthKey, QuickAuthRequest, QuickAuthResult } from './quick-auth';

const a = { serverUrl: 'https://a.example', email: 'same@example.test' };
const b = { serverUrl: 'https://b.example', email: 'same@example.test' };
const password = 'test-master-password';
const cleanups: (() => void)[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const userKey = makeUserKey();
  const master = await deriveMasterKey(password, a.email, { kdf: 0, iterations: 1000 });
  const wrapped = await encryptBytes(concatBytes(userKey.encKey, userKey.macKey), await stretchMasterKey(master));
  const hash = await hashMasterPassword(master, password);
  const requiresTwoFactor = new Set<string>();
  const authentications: string[] = [];
  let pause: { pathname: string; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  installHost({ storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (pause?.pathname === url.pathname) { pause.started.resolve(); await pause.release.promise; }
      switch (url.pathname) {
        case '/identity/accounts/prelogin': return Response.json({ kdf: 0, kdfIterations: 1000 });
        case '/identity/connect/token': {
          authentications.push(url.origin);
          const body = new URLSearchParams(String(init?.body));
          if (body.get('password') !== hash) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          if (requiresTwoFactor.has(url.origin)) {
            if (!body.has('twoFactorToken')) return Response.json({ TwoFactorProviders: ['0'], TwoFactorProviders2: { '0': null } }, { status: 400 });
            if (body.get('twoFactorToken') !== '123456') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          return Response.json({ access_token: `e30.${btoa(JSON.stringify({ sub: url.hostname }))}.test`, expires_in: 3600, Key: wrapped, Kdf: 0 });
        }
        case '/api/accounts/revision-date': return new Response('1');
        case '/api/sync': return Response.json({ profile: { id: url.hostname, email: a.email }, ciphers: [], folders: [], collections: [] });
        default: throw Error(`Unexpected request: ${url.pathname}`);
      }
    },
  });
  const runtime = createDesktopApplication();
  const vaults = new Set<VaultClient>([runtime.getActiveVault()]);
  const stop = runtime.subscribeActiveVault(() => vaults.add(runtime.getActiveVault()));
  await runtime.client.initialize();
  let accounts = [a, b].map(target => ({ ...target, id: accountKey(target), displayName: '', avatarDataUrl: null }));
  let nativeCurrent: QuickAuthKey | null = null;
  let nativeAccepted = false;
  let replyPause: { when: 'before' | 'after'; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  let generation = 1; let sequence = 0;
  const replies: QuickAuthResult[] = [];
  let navigationPause: ReturnType<typeof deferred> | null = null;
  const opened = vi.fn(async (target: typeof a | null, assertCurrent?: () => Promise<void>) => {
    if (navigationPause) await navigationPause.promise;
    await assertCurrent?.();
    await runtime.client.switchAccount(target);
    await assertCurrent?.();
  });
  const coordinator = createQuickAuthCoordinator({
    getActiveVault: runtime.getActiveVault, subscribeActiveVault: runtime.subscribeActiveVault,
    subscribeVaultChanges: runtime.subscribeVaultChanges,
    loadAccounts: async () => accounts, openAccount: opened, refresh: runtime.client.refresh,
    isCurrent: async key => {
      expect(Object.keys(key).sort()).toEqual(['generation', 'requestId']);
      return nativeCurrent?.generation === key.generation && nativeCurrent.requestId === key.requestId;
    },
    reply: async result => {
      if (result.stage === 'unlocked' && replyPause?.when === 'before') { replyPause.started.resolve(); await replyPause.release.promise; }
      if (nativeCurrent?.generation !== result.generation || nativeCurrent.requestId !== result.requestId) return false;
      replies.push(result);
      nativeAccepted ||= result.stage === 'unlocked' && !result.error;
      if (result.stage === 'unlocked' && replyPause?.when === 'after') { replyPause.started.resolve(); await replyPause.release.promise; }
      return true;
    },
  });
  const request = async (account: typeof a, action: QuickAuthRequest['action'], fields: Partial<QuickAuthRequest> = {}) => {
    const payload: QuickAuthRequest = { generation, requestId: ++sequence, accountId: accountKey(account), action, ...fields };
    nativeCurrent = { generation: payload.generation, requestId: payload.requestId };
    nativeAccepted = false;
    await coordinator.request(payload);
    return payload;
  };
  cleanups.push(() => { coordinator.dispose(); stop(); for (const vault of vaults) vault.logout(); runtime.client.dispose(); });
  return { runtime, coordinator, request, replies, authentications, requiresTwoFactor, opened,
    remove(account: typeof a) { accounts = accounts.filter(value => value.id !== accountKey(account)); },
    cancel() { const key = { ...nativeCurrent!, unlocked: nativeAccepted }; nativeCurrent = null; coordinator.cancel(key); return key; },
    reopen() { generation++; sequence = 0; },
    pauseNavigation() { navigationPause = deferred(); return navigationPause; },
    pauseUnlockedReply(when: 'before' | 'after') { replyPause = { when, started: deferred(), release: deferred() }; return replyPause; },
    pauseRequest(pathname: string) { pause = { pathname, started: deferred(), release: deferred() }; return pause; },
  };
}
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'quick-auth-test-device', setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); resetHost(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('selects a remembered identity without authenticating and returns a parked unlocked session without a password', async () => {
  const f = await fixture();
  await f.request(a, 'select');
  expect(f.replies.at(-1)).toMatchObject({ accountId: accountKey(a), stage: 'password' });
  expect(f.authentications).toEqual([]);
  await f.runtime.client.unlock(password); const parked = f.runtime.getActiveVault();
  await f.request(b, 'select');
  expect(parked.isUnlocked()).toBe(true);
  await f.request(a, 'select');
  expect(f.runtime.getActiveVault()).toBe(parked);
  expect(f.replies.at(-1)).toMatchObject({ accountId: accountKey(a), stage: 'unlocked' });
  expect(f.authentications).toEqual([a.serverUrl]);
});

it('reports a wrong password, clears the transported input, and allows a fresh retry', async () => {
  const f = await fixture(); await f.request(a, 'select');
  const sent = await f.request(a, 'password', { password: 'wrong' });
  expect(sent.password).toBeUndefined();
  expect(f.replies.at(-1)).toMatchObject({ stage: 'password', error: expect.any(String) });
  expect(f.runtime.getActiveVault().isUnlocked()).toBe(false);
  await f.request(a, 'password', { password });
  expect(f.replies.at(-1)).toMatchObject({ stage: 'unlocked' });
  expect(f.runtime.client.getSnapshot().status).toBe('unlocked');
  expect(JSON.stringify(f.replies)).not.toContain(password);
});

it('retains the captured two-factor challenge and providers after an incorrect code', async () => {
  const f = await fixture(); f.requiresTwoFactor.add(a.serverUrl); await f.request(a, 'select');
  await f.request(a, 'password', { password });
  expect(f.replies.at(-1)).toMatchObject({ stage: 'twoFactor', providers: [0] });
  const sent = await f.request(a, 'twoFactor', { code: 'wrong', provider: 0, remember: false });
  expect(sent.code).toBeUndefined();
  expect(f.replies.at(-1)).toMatchObject({ stage: 'twoFactor', providers: [0], error: '验证码不正确或已过期，请重试' });
  await f.request(a, 'twoFactor', { code: '123456', provider: 0, remember: false });
  expect(f.replies.at(-1)).toMatchObject({ stage: 'unlocked' });
});

it('cancels an asynchronous password and cannot revive a reopened quick window', async () => {
  const f = await fixture(); await f.request(a, 'select'); const oldVault = f.runtime.getActiveVault();
  const paused = f.pauseRequest('/identity/connect/token');
  const pending = f.request(a, 'password', { password }); await paused.started.promise;
  const cancelled = f.cancel(); f.reopen();
  await f.request(b, 'select'); const currentVault = f.runtime.getActiveVault();
  paused.release.resolve(); await pending;
  expect(oldVault.isUnlocked()).toBe(false); expect(currentVault.getSession().account).toMatchObject(b);
  expect(f.replies.filter(result => result.generation === cancelled.generation && result.requestId === cancelled.requestId)).toEqual([]);
  expect(f.replies.at(-1)).toMatchObject({ generation: 2, accountId: accountKey(b), stage: 'password' });
});

it('rejects an account removed after selection and invalidates its pending challenge', async () => {
  const f = await fixture(); f.requiresTwoFactor.add(a.serverUrl); await f.request(a, 'select');
  await f.request(a, 'password', { password }); const vault = f.runtime.getActiveVault();
  f.remove(a); await f.request(a, 'twoFactor', { code: '123456', provider: 0 });
  expect(f.replies.at(-1)).toMatchObject({ stage: 'password', error: '账户已移除，请重新选择' });
  await expect(vault.connectWithTwoFactor('123456', 0, false)).rejects.toMatchObject({ kind: 'authRestartRequired' });
});

it('cancels during the navigation save boundary before mutating the selected account', async () => {
  const f = await fixture(); await f.runtime.client.switchAccount(a); const vault = f.runtime.getActiveVault();
  const paused = f.pauseNavigation(); const pending = f.request(b, 'select');
  await vi.waitFor(() => expect(f.opened).toHaveBeenCalledOnce());
  f.cancel(); paused.resolve(); await pending;
  expect(f.runtime.getActiveVault()).toBe(vault); expect(f.replies).toEqual([]);
});

it('invalidates A → B → A selection while preserving an unrelated parked unlocked vault', async () => {
  const f = await fixture(); await f.runtime.client.switchAccount(b); await f.runtime.client.unlock(password);
  const parked = f.runtime.getActiveVault(); await f.request(a, 'select'); const aVault = f.runtime.getActiveVault();
  const paused = f.pauseRequest('/identity/connect/token');
  const pending = f.request(a, 'password', { password }); await paused.started.promise;
  await f.runtime.client.switchAccount(b); await f.runtime.client.switchAccount(a);
  paused.release.resolve(); await pending;
  expect(aVault.isUnlocked()).toBe(false); expect(parked.isUnlocked()).toBe(true);
  expect(f.replies.at(-1)?.stage).not.toBe('unlocked');
});

it('publishes successful authentication before a slow initial sync finishes', async () => {
  const f = await fixture(); await f.request(a, 'select'); const paused = f.pauseRequest('/api/sync');
  const pending = f.request(a, 'password', { password }); await paused.started.promise;
  await vi.waitFor(() => expect(f.replies.at(-1)).toMatchObject({ stage: 'unlocked' }));
  expect(f.runtime.getActiveVault().getSession().syncing).toBe(true);
  f.cancel(); expect(f.runtime.getActiveVault().isUnlocked()).toBe(true);
  paused.release.resolve(); await pending;
});

it('an old cancellation token cannot cancel a newer main-window authentication on the same vault', async () => {
  const f = await fixture(); await f.request(a, 'select'); const vault = f.runtime.getActiveVault();
  const paused = f.pauseRequest('/identity/connect/token');
  const oldAttempt = vault.unlock(password).catch(() => {}); const old = vault.captureAuthentication();
  await paused.started.promise;
  const newer = vault.unlock(password); const current = vault.captureAuthentication();
  old.cancel(); expect(current.isCurrent()).toBe(true);
  paused.release.resolve(); await Promise.all([oldAttempt, newer]);
  expect(vault.isUnlocked()).toBe(true);
});

it('returns from a cancelled two-factor challenge to a working password retry for the same account', async () => {
  const f = await fixture(); f.requiresTwoFactor.add(a.serverUrl); await f.request(a, 'select');
  await f.request(a, 'password', { password }); f.cancel();
  await f.request(a, 'password', { password });
  expect(f.opened).toHaveBeenCalledOnce();
  expect(f.replies.at(-1)).toMatchObject({ stage: 'twoFactor', providers: [0] });
  await f.request(a, 'twoFactor', { code: '123456', provider: 0 });
  expect(f.replies.at(-1)).toMatchObject({ stage: 'unlocked' });
});

it('locks its own just-authenticated session when cancelled before native success acceptance', async () => {
  const f = await fixture(); await f.request(a, 'select');
  const sync = f.pauseRequest('/api/sync'); const reply = f.pauseUnlockedReply('before');
  const pending = f.request(a, 'password', { password });
  await sync.started.promise; await reply.started.promise;
  expect(f.runtime.getActiveVault().isUnlocked()).toBe(true);
  f.cancel(); expect(f.runtime.getActiveVault().isUnlocked()).toBe(false);
  reply.release.resolve(); sync.release.resolve(); await pending;
  expect(f.runtime.getActiveVault().isUnlocked()).toBe(false);
  expect(f.replies.some(result => result.stage === 'unlocked')).toBe(false);
});

it('preserves accepted success if hide arrives before the native completion acknowledgment', async () => {
  const f = await fixture(); await f.request(a, 'select');
  const sync = f.pauseRequest('/api/sync'); const reply = f.pauseUnlockedReply('after');
  const pending = f.request(a, 'password', { password });
  await sync.started.promise; await reply.started.promise;
  expect(f.replies.at(-1)).toMatchObject({ stage: 'unlocked' });
  f.cancel(); expect(f.runtime.getActiveVault().isUnlocked()).toBe(true);
  reply.release.resolve(); sync.release.resolve(); await pending;
  expect(f.runtime.getActiveVault().isUnlocked()).toBe(true);
});
