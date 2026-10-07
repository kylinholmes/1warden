import { describe, expect, it } from 'vitest';
import { createApplicationClient } from './client';
import { EMPTY_SNAPSHOT, type ApplicationService, type ApplicationSnapshot } from './types';

const options = { capabilities: { native: false, browser: false, saveAttachments: false }, saveFile: async () => ({ path: null }) };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const unlocked: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', revision: 1 };

describe('application client lifecycle', () => {
  it('allows its own successful connection to publish the new account', async () => {
    let notify = () => {};
    let connected = false;
    const account = { email: 'me@example.com', serverUrl: 'https://vault.example', userId: 'u', kdf: { kdf: 0 as const, iterations: 1 } };
    const client = createApplicationClient({
      snapshot: async () => connected ? { ...unlocked, account } : EMPTY_SNAPSHOT,
      connect: async () => { connected = true; notify(); await Promise.resolve(); await Promise.resolve(); },
    } as unknown as ApplicationService, {
      ...options, subscribeRemote(listener) { notify = listener; return () => {}; },
    });
    await client.initialize();
    await expect(client.connect({ email: account.email, serverUrl: account.serverUrl, masterPassword: 'test' })).resolves.toBeUndefined();
    expect(client.getSnapshot().account?.email).toBe(account.email);
    client.dispose();
  });
  it('discards a snapshot requested before lock, even if it arrives after lock', async () => {
    const old = deferred<ApplicationSnapshot>();
    let reads = 0;
    const service = {
      snapshot: () => ++reads === 1 ? old.promise : Promise.resolve({ ...EMPTY_SNAPSHOT, status: 'locked' }),
      lock: async () => {},
    } as ApplicationService;
    const client = createApplicationClient(service, options);
    const load = client.initialize();
    await client.lock();
    old.resolve(unlocked);
    await load;
    expect(client.getSnapshot().status).toBe('locked');
    client.dispose();
  });

  it('rejects secret results that cross a lock boundary', async () => {
    const secret = deferred<string>();
    const client = createApplicationClient({
      snapshot: async () => unlocked,
      reveal: () => secret.promise,
      lock: async () => {},
    } as unknown as ApplicationService, options);
    await client.initialize();
    const result = client.reveal('item', { kind: 'password' });
    const rejection = expect(result).rejects.toThrow(/锁定|过期/);
    await client.lock();
    secret.resolve('must-not-be-rendered');
    await rejection;
    client.dispose();
  });

  it('refreshes the snapshot after a mutation and keeps snapshot identity stable between updates', async () => {
    let favorite = false;
    const client = createApplicationClient({
      snapshot: async () => ({ ...unlocked, revision: favorite ? 2 : 1 }),
      toggleFavorite: async () => { favorite = true; },
    } as unknown as ApplicationService, options);
    await client.initialize();
    const before = client.getSnapshot();
    expect(client.getSnapshot()).toBe(before);
    await client.toggleFavorite('item');
    expect(client.getSnapshot().revision).toBe(2);
    expect(client.getSnapshot()).not.toBe(before);
    client.dispose();
  });
});

it('switching account retires pending secret reads and publishes only the target identity', async () => {
  const secret = deferred<string>();
  const a = { email: 'a@example.com', serverUrl: 'https://one.example', userId: 'a', kdf: { kdf: 0 as const, iterations: 1 } };
  const b = { ...a, email: 'b@example.com', userId: '' };
  let current: ApplicationSnapshot = { ...unlocked, account: a, profile: { displayName: 'A', avatarDataUrl: null } };
  const client = createApplicationClient({
    snapshot: async () => current, reveal: () => secret.promise,
    switchAccount: async () => { current = { ...EMPTY_SNAPSHOT, status: 'locked', account: b }; },
  } as unknown as ApplicationService, options);
  await client.initialize();
  const revealing = client.reveal('a-item', { kind: 'password' });
  const rejected = expect(revealing).rejects.toThrow(/锁定|过期/);
  await client.switchAccount(b);
  secret.resolve('a-secret'); await rejected;
  expect(client.getSnapshot().account?.email).toBe(b.email);
  expect(client.getSnapshot().profile).toBeNull(); expect(client.getSnapshot().items).toEqual([]);
  client.dispose();
});
