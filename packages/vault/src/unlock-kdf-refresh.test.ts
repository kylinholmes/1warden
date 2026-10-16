import { expect, it } from 'vitest';
import { deriveMasterKey, hashMasterPassword, makeUserKey, stretchMasterKey } from '@1warden/crypto';
import { VaultClient } from './client';
import { createFakeServer } from './testing/fake-server';
import type { KdfCacheEntry } from './sync-engine';

async function fixture(iterations: number) {
  const account = { serverUrl: 'https://vault.test', email: 'synthetic@example.test' };
  const password = 'synthetic-password';
  const key = await deriveMasterKey(password, account.email, { kdf: 0, iterations });
  const hash = await hashMasterPassword(key, password);
  let cached: KdfCacheEntry = { ...account, kdf: { kdf: 0, iterations: 1000 } };
  const server = createFakeServer({ userKey: makeUserKey(), stretchedMasterKey: await stretchMasterKey(key), kdfIterations: iterations,
    override: (path, init) => path.endsWith('/token') && new URLSearchParams(String(init?.body)).get('password') !== hash
      ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : undefined });
  const client = new VaultClient({ fetchImpl: server.fetchImpl, deviceStore: { get: () => 'synthetic', set() {}, clear() {} },
    kdfCache: { load: async () => cached, save: async value => { cached = value; } } });
  client.getSession().setAccount({ ...account, userId: 'synthetic', kdf: cached.kdf });
  return { client, server, password, cache: () => cached };
}
it('refreshes changed server KDF parameters and unlocks without making the user restart login', async () => {
  const f = await fixture(2000);
  try {
    await f.client.unlock(f.password);
    expect(f.client.isUnlocked()).toBe(true); expect(f.cache().kdf.iterations).toBe(2000);
    expect(f.server.calls.filter(path => path.endsWith('/token'))).toHaveLength(2);
    expect(f.server.calls.filter(path => path.endsWith('/prelogin'))).toHaveLength(1);
  } finally { f.client.logout(); }
});
it('does not retry an incorrect password when the cached parameters are unchanged', async () => {
  const f = await fixture(1000);
  try {
    await expect(f.client.unlock('wrong')).rejects.toMatchObject({ kind: 'auth' });
    expect(f.server.calls.filter(path => path.endsWith('/token'))).toHaveLength(1);
    expect(f.client.isUnlocked()).toBe(false);
  } finally { f.client.logout(); }
});
