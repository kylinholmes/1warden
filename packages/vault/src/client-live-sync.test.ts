import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultClient, type VaultClientState } from './client';

const clients: VaultClient[] = [];
afterEach(() => { clients.forEach(c => c.logout()); clients.length = 0; });

function fixture() {
  let notify!: { onSync(): void; onLogout(): void; accessToken(): Promise<string> };
  const stop = vi.fn();
  let reads = 0;
  let renewals = 0;
  let hold: Promise<void> | undefined;
  const client = new VaultClient({
    deviceStore: { get: () => 'device', set() {}, clear() {} },
    fetchImpl: async input => {
      if (String(input).endsWith('/identity/connect/token')) { renewals++; return Response.json({ access_token: 'renewed', refresh_token: 'next' }); }
      if (String(input).endsWith('/revision-date')) return Response.json(1);
      reads++;
      await hold;
      return Response.json({ Ciphers: [], Folders: [] });
    },
    notifications: options => { notify = options; return stop; },
  });
  const state: VaultClientState = {
    account: { serverUrl: 'https://vault.test', email: 'a@test', userId: 'a', kdf: { kdf: 0, iterations: 1000 } },
    userKey: makeUserKey(), items: [], folders: [],
    token: { accessToken: 'token', refreshToken: undefined, expiresIn: 3600, key: undefined, privateKey: undefined, kdf: undefined },
  };
  clients.push(client);
  client.restore(state);
  return { client, stop, state, notify: () => notify, reads: () => reads, renewals: () => renewals,
    hold(p: Promise<void>) { hold = p; } };
}

describe('live synchronization lifecycle', () => {
  it('renews an expired token once for concurrent reconnect and sync requests', async () => {
    const f = fixture();
    const token = `header.${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    f.client.restore({ ...f.state, userKey: makeUserKey(), token: { ...f.state.token!, accessToken: token, refreshToken: 'refresh' } });
    const results = await Promise.all([f.notify().accessToken(), f.notify().accessToken(), f.client.refresh()]);
    expect(results.slice(0, 2)).toEqual(['renewed', 'renewed']);
    expect(f.renewals()).toBe(1);
    expect(f.client.exportState().token?.accessToken).toBe('renewed');
  });
  it('syncs an unlocked account on push and disconnects on lock', async () => {
    const f = fixture();
    expect(f.notify()).toBeDefined();
    f.notify().onSync();
    await vi.waitFor(() => expect(f.client.hasVerifiedSync()).toBe(true));
    expect(f.reads()).toBe(1);
    f.client.lock();
    expect(f.stop).toHaveBeenCalledOnce();
    f.notify().onSync();
    await Promise.resolve();
    expect(f.reads()).toBe(1);
  });

  it('coalesces triggers during a running sync into a fresh follow-up request', async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(new Promise<void>(r => { release = r; }));
    const first = f.client.refresh();
    await vi.waitFor(() => expect(f.reads()).toBe(1));
    const second = f.client.refresh();
    const third = f.client.refresh();
    release();
    await Promise.all([first, second, third]);
    expect(f.reads()).toBe(2);
    expect(f.client.getSession().syncing).toBe(false);
  });

  it('still drains a queued trigger when the current sync fails', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.hold(new Promise<void>((_, r) => { reject = r; }));
    const first = f.client.refresh();
    await vi.waitFor(() => expect(f.reads()).toBe(1));
    const next = f.client.refresh();
    f.hold(Promise.resolve());
    reject(new Error('transient network failure'));
    await expect(Promise.all([first, next])).resolves.toEqual([undefined, undefined]);
    expect(f.reads()).toBe(2);
    expect(f.client.hasVerifiedSync()).toBe(true);
    expect(f.client.syncError).toBeNull();
  });

  it('ignores stale push callbacks after replacing an account', async () => {
    const f = fixture();
    const previous = f.notify();
    f.client.lock();
    f.client.restore({ ...f.state, userKey: makeUserKey(), account: { ...f.state.account, email: 'b@test', userId: 'b' } });
    previous.onSync(); previous.onLogout();
    await Promise.resolve();
    expect(f.reads()).toBe(0);
    expect(f.client.isUnlocked()).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('does not send a new account token to the previous server after a sync is queued', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const f = fixture();
    const client = new VaultClient({ fetchImpl: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json(String(url).endsWith('/revision-date') ? 1 : { Ciphers: [], Folders: [] });
    } });
    clients.push(client);
    client.restore({ ...f.state, userKey: makeUserKey() });
    const pending = client.refresh();
    client.lock();
    client.restore({ ...f.state, userKey: makeUserKey(), account: { ...f.state.account, serverUrl: 'https://other.test' },
      token: { ...f.state.token!, accessToken: 'other-account-token' } });
    await pending.catch(() => {});
    expect(requests).toEqual([]);
  });

  it('locks the owning session on a server logout notification', () => {
    const f = fixture();
    expect(f.notify()).toBeDefined();
    f.notify().onLogout();
    expect(f.client.isUnlocked()).toBe(false);
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
