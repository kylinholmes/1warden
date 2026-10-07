import { describe, expect, it } from 'vitest';
import { createProfileCache } from './profile-cache';

const account = { serverUrl: 'https://vault.example', email: 'a@example.com' };
function storage() {
  const values = new Map<string, string>();
  return { values, get: async (k: string) => values.get(k) ?? null,
    set: async (k: string, v: string) => { values.set(k, v); }, remove: async (k: string) => { values.delete(k); } };
}
describe('local presentation cache', () => {
  it('whitelists display information, survives reopening, and isolates accounts', async () => {
    const disk = storage(); const cache = createProfileCache(disk);
    await cache.save(account, { displayName: 'Lin', avatarDataUrl: null, password: 'secret', notes: 'private' } as never);
    expect(JSON.stringify([...disk.values.values()])).not.toMatch(/secret|private|password|notes/);
    expect(await createProfileCache(disk).load(account)).toEqual({ displayName: 'Lin', avatarDataUrl: null });
    expect(await cache.load({ ...account, email: 'b@example.com' })).toBeNull();
    expect(await cache.load({ ...account, serverUrl: 'https://another.example' })).toBeNull();
  });
  it('logout drains pending writes before removing the cache', async () => {
    const disk = storage(); let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const cache = createProfileCache({ ...disk, set: async (k, v) => { await wait; await disk.set(k, v); } });
    const saving = cache.save(account, { displayName: 'Lin', avatarDataUrl: null });
    const clearing = cache.clear(account);
    release(); await saving; await clearing;
    expect(await cache.load(account)).toBeNull(); expect(disk.values.size).toBe(0);
  });
  it('ignores corrupted cache and unavailable storage', async () => {
    const cache = createProfileCache({ get: async () => '{', set: async () => { throw Error('full'); }, remove: async () => {} });
    expect(await cache.load(account)).toBeNull();
    await expect(cache.save(account, { displayName: 'Lin', avatarDataUrl: null })).resolves.toBeUndefined();
  });
});
