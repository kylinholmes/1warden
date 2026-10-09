import { describe, expect, it, vi } from 'vitest';
import { deriveMasterKey, makeUserKey, stretchMasterKey } from '@1warden/crypto';
import { VaultClient } from './client';
import { createFakeServer } from './testing/fake-server';

const params = { email: 'sync-status@example.com', serverUrl: 'https://vault.test', masterPassword: 'test-password' };
const deviceStore = { get: () => 'test-device', set: () => {}, clear: () => {} };
async function fixture() {
  const userKey = makeUserKey();
  const fake = createFakeServer({ userKey, stretchedMasterKey: await stretchMasterKey(
    await deriveMasterKey(params.masterPassword, params.email, { kdf: 0, iterations: 1000 })),
  });
  let fail = true;
  let pending: Promise<void> | undefined;
  const syncEvents: boolean[] = [];
  const client = new VaultClient({ deviceStore, onSync: value => syncEvents.push(value), fetchImpl: async (input, init) => {
    if (new URL(String(input)).pathname === '/api/sync') {
      await pending;
      if (fail) return Response.json({ message: 'server-internal-sensitive-detail' }, { status: 503 });
    }
    return fake.fetchImpl(input, init);
  } });
  return { client, syncEvents, setFailure(value: boolean) { fail = value; }, setPending(value: Promise<void>) { pending = value; } };
}

describe('visible synchronization failures and recovery', () => {
  it('keeps a failed initial sync unlocked but reports an error instead of a confirmed empty vault', async () => {
    const { client, syncEvents } = await fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await client.connect(params); } finally { warning.mockRestore(); }
    expect(client.getSession().status).toBe('unlocked');
    expect(client.getSession().syncing).toBe(false);
    expect(client.syncError).toMatch(/同步失败/);
    expect(client.syncError).not.toContain('sensitive');
    expect(client.lastSyncedAt).toBeNull();
    expect(syncEvents).toEqual([true, false]);
  });

  it('retries successfully and retains the last successful time if a later refresh fails', async () => {
    const { client, setFailure } = await fixture();
    setFailure(false); await client.connect(params);
    const succeededAt = client.lastSyncedAt;
    expect(succeededAt).toEqual(expect.any(Number));
    expect(client.syncError).toBeNull();
    setFailure(true);
    await expect(client.refresh()).rejects.toThrow();
    expect(client.syncError).toMatch(/同步失败/);
    expect(client.lastSyncedAt).toBe(succeededAt);
    setFailure(false); await client.refresh();
    expect(client.syncError).toBeNull();
    expect(client.hasVerifiedSync()).toBe(true);
  });

  it('does not carry sync errors through lock, logout or the next account', async () => {
    const { client } = await fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await client.connect(params); } finally { warning.mockRestore(); }
    expect(client.syncError).not.toBeNull();
    client.lock();
    expect(client.syncError).toBeNull(); expect(client.lastSyncedAt).toBeNull();
    client.logout();
    expect(client.syncError).toBeNull(); expect(client.lastSyncedAt).toBeNull();
  });

  it('ignores a late failure after lock and a different session restore', async () => {
    const { client, setFailure, setPending } = await fixture();
    setFailure(false); await client.connect(params);
    const restored = client.exportState();
    restored.userKey = makeUserKey();
    restored.account = { ...restored.account, email: 'other@example.com' };
    let release!: () => void;
    setPending(new Promise<void>(resolve => { release = resolve; }));
    setFailure(true);
    const refresh = client.refresh().catch(() => {});
    client.lock(); client.restore(restored);
    release(); await refresh;
    expect(client.syncError).toBeNull();
    expect(client.getSession().account?.email).toBe('other@example.com');
    expect(client.hasVerifiedSync()).toBe(true);
  });

  it('preserves errors and freshness across worker-state export/restore', async () => {
    const { client, setFailure } = await fixture();
    setFailure(false); await client.connect(params);
    setFailure(true); await client.refresh().catch(() => {});
    const restored = new VaultClient({ deviceStore, fetchImpl: async () => { throw Error('Unexpected network'); } });
    restored.restore(client.exportState());
    expect(restored.syncError).toBe(client.syncError);
    expect(restored.lastSyncedAt).toBe(client.lastSyncedAt);
  });
});
