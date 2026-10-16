import { describe, expect, it } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { GeneratedPasswordStore } from './generated-password-store';

function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); },
    remove: async (key: string) => { delete data[key]; } };
  let now = Date.now();
  const store = new GeneratedPasswordStore(storage, () => now);
  const context = { account: 'account-a', key: makeUserKey(), assertCurrent() {} };
  return { data, storage, store, context, advance(ms: number) { now += ms; } };
}
describe('encrypted generated password recovery', () => {
  it('persists ciphertext and recovers across a new store instance only for its account', async () => {
    const f = fixture();
    const row = await f.store.add(f.context, 'https://example.test/signup', 'synthetic-secret-123');
    expect(JSON.stringify(f.data)).not.toContain('synthetic-secret-123');
    expect(JSON.stringify(f.data)).not.toContain('example.test');
    const restored = new GeneratedPasswordStore(f.storage);
    expect(await restored.reveal(f.context, row.id)).toBe('synthetic-secret-123');
    expect(await restored.list({ ...f.context, account: 'other' })).toEqual([]);
    await expect(restored.reveal({ ...f.context, key: makeUserKey() }, row.id)).rejects.toThrow();
  });
  it('keeps the latest 100 used values for 30 days and supports explicit deletion', async () => {
    const f = fixture();
    for (let n = 0; n < 101; n++) { await f.store.add(f.context, 'https://example.test', `synthetic-${n}`); f.advance(1); }
    const rows = await f.store.list(f.context);
    expect(rows).toHaveLength(100);
    await f.store.remove(f.context, rows[0]!.id);
    expect(await f.store.list(f.context)).toHaveLength(99);
    f.advance(31 * 86400_000);
    expect(await f.store.list(f.context)).toEqual([]);
  });
  it('does not write after the owner locks and clears only the logged out account', async () => {
    const f = fixture();
    const row = await f.store.add(f.context, 'https://example.test', 'secret');
    await expect(f.store.add({ ...f.context, assertCurrent() { throw new Error('locked'); } }, 'https://example.test', 'late')).rejects.toThrow('locked');
    await f.store.clear(f.context.account);
    await expect(f.store.reveal(f.context, row.id)).rejects.toThrow();
  });
});
