import { describe, expect, it, vi } from 'vitest';
import { deriveMasterKey, makeUserKey, stretchMasterKey } from '@coffer/crypto';
import { VaultClient, type VaultClientState } from './client';
import { createFakeServer } from './testing/fake-server';

const params = { email: 'sync@example.com', serverUrl: 'https://vault.test', masterPassword: 'test-password' };
const account = { email: params.email, serverUrl: params.serverUrl, userId: 'user', kdf: { kdf: 0 as const, iterations: 1000 } };
const deviceStore = { get: () => 'test-device', set: () => {}, clear: () => {} };

async function server() {
  return createFakeServer({ userKey: makeUserKey(), stretchedMasterKey: await stretchMasterKey(
    await deriveMasterKey(params.masterPassword, params.email, account.kdf)),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('VaultClient authoritative sync readiness', () => {
  it('stays unverified while unlocked and waiting for the initial sync', async () => {
    const fake = await server();
    const started = deferred(); const release = deferred();
    const observed: Array<boolean | undefined> = [];
    const client = new VaultClient({ deviceStore,
      onStatus: (status) => { if (status === 'unlocked') observed.push(client.hasVerifiedSync?.()); },
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/sync') { started.resolve(); await release.promise; }
        return fake.fetchImpl(input, init);
      },
    });
    const connecting = client.connect(params);
    await started.promise;
    try {
      expect(client.isUnlocked()).toBe(true);
      expect(client.hasVerifiedSync()).toBe(false);
      expect(observed).toEqual([false]);
    } finally { release.resolve(); await connecting; }
    expect(client.hasVerifiedSync()).toBe(true);
    expect(client.exportState().syncVerified).toBe(true);
  });

  it('does not mark failed initial synchronization as verified', async () => {
    const fake = await server();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new VaultClient({ deviceStore, fetchImpl: async (input, init) =>
      new URL(String(input)).pathname === '/api/sync'
        ? Response.json({ message: 'sync failed' }, { status: 503 }) : fake.fetchImpl(input, init),
    });
    try {
      await client.connect(params);
      expect(client.isUnlocked()).toBe(true);
      expect(client.getSession().syncing).toBe(false);
      expect(client.hasVerifiedSync()).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it('does not treat a sync that skipped an undecryptable cipher as complete', async () => {
    const fake = await server();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new VaultClient({ deviceStore, fetchImpl: async (input, init) =>
      new URL(String(input)).pathname === '/api/sync'
        ? Response.json({ profile: { id: 'user', email: params.email }, folders: [], collections: [],
          ciphers: [{ id: 'unreadable-profile', type: 2, name: 'bad', key: '2.invalid' }] }) : fake.fetchImpl(input, init),
    });
    try {
      await client.connect(params);
      expect(client.getSession().items).toHaveLength(0);
      expect(client.hasVerifiedSync()).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it('does not let a late successful sync reverify a locked session', async () => {
    const fake = await server();
    const started = deferred(); const release = deferred();
    const client = new VaultClient({ deviceStore, fetchImpl: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/sync') { started.resolve(); await release.promise; }
      return fake.fetchImpl(input, init);
    } });
    const connecting = client.connect(params).catch(() => {});
    await started.promise;
    client.lock(); release.resolve(); await connecting;
    expect(client.hasVerifiedSync()).toBe(false);
  });

  it('resets readiness before a new authentication publishes unlocked', async () => {
    const fake = await server();
    const observed: Array<boolean | undefined> = [];
    const client = new VaultClient({ deviceStore, fetchImpl: fake.fetchImpl,
      onStatus: (status) => { if (status === 'unlocked') observed.push(client.hasVerifiedSync?.()); },
    });
    await client.connect(params);
    expect(client.hasVerifiedSync()).toBe(true);
    client.lock(); expect(client.hasVerifiedSync()).toBe(false);
    await client.unlock(params.masterPassword);
    expect(observed).toEqual([false, false]);
    expect(client.hasVerifiedSync()).toBe(true);
    client.logout(); expect(client.hasVerifiedSync()).toBe(false);
  });

  it.each([true, false, undefined])('restores readiness only from explicit true (%s)', (syncVerified) => {
    const state: VaultClientState = { account, userKey: makeUserKey(), items: [], folders: [], token: null,
      ...(syncVerified === undefined ? {} : { syncVerified }),
    };
    const client = new VaultClient({ deviceStore, fetchImpl: async () => { throw Error('Unexpected network'); } });
    client.restore(state);
    expect(client.hasVerifiedSync()).toBe(syncVerified === true);
    expect(client.exportState().syncVerified).toBe(syncVerified === true);
  });
});
