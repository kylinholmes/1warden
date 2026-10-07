import { describe, expect, it } from 'vitest';
import { SessionStore, SESSION_DURATION_MS, type StorageArea, type UnlockedSession } from './session-store';
import { accountKey } from '../src/application/account-target';

function fixture() {
  const values: Record<string, unknown> = {};
  const area: StorageArea = {
    get: async (keys) => keys === null ? { ...values } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])),
    set: async (items) => { Object.assign(values, items); },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    clear: async () => { for (const key of Object.keys(values)) delete values[key]; },
  };
  let now = 1000;
  const store = new SessionStore(area, () => now);
  const a: UnlockedSession = { account: { serverUrl: 'https://one.example', email: 'same@example.com', userId: 'a', kdf: { kdf: 0, iterations: 1 } },
    userKey: { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) }, items: [], folders: [], token: null, syncVerified: true };
  const b = { ...a, account: { ...a.account, serverUrl: 'https://two.example', userId: 'b' }, userKey: { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) } };
  return { values, area, store, a, b, advance(ms: number) { now += ms; } };
}

describe('independent browser account sessions', () => {
  it('parks a session for Add Account and restores it without extending its deadline', async () => {
    const { store, a, advance } = fixture();
    await store.start(a);
    const deadline = await store.expiresAt();
    advance(100);
    expect(await store.select(null)).toBeNull();
    expect(await store.load()).toBeNull();
    expect(await store.unlockedAccounts()).toEqual([accountKey(a.account)]);
    expect(await store.select(a.account)).toEqual(a);
    expect(await store.expiresAt()).toBe(deadline);
  });

  it('keeps same-email sessions on different backends independent through worker restoration', async () => {
    const { store, area, a, b } = fixture();
    await store.start(a); await store.select(b.account); await store.start(b);
    const restarted = new SessionStore(area, () => 1000);
    expect(await restarted.select(a.account)).toEqual(a);
    expect(await restarted.select(b.account)).toEqual(b);
    expect((await restarted.unlockedAccounts()).sort()).toEqual([accountKey(a.account), accountKey(b.account)].sort());
  });

  it('clears only the selected account on lock or logout', async () => {
    const { store, a, b } = fixture();
    await store.start(a); await store.select(b.account); await store.start(b);
    await store.clear({ forgetAccount: true });
    expect(await store.select(b.account)).toBeNull();
    expect(await store.select(a.account)).toEqual(a);
    await store.clear();
    expect(await store.select(a.account)).toBeNull();
    expect(await store.unlockedAccounts()).toEqual([]);
  });

  it('expires parked sessions at their own absolute deadlines', async () => {
    const { store, a, b, advance } = fixture();
    await store.start(a); advance(100);
    await store.select(b.account); await store.start(b);
    expect(await store.nextExpiry()).toBe(1000 + SESSION_DURATION_MS);
    advance(SESSION_DURATION_MS - 50);
    expect(await store.expire()).toBe(false);
    expect(await store.select(a.account)).toBeNull();
    expect(await store.select(b.account)).toEqual(b);
    advance(51);
    expect(await store.expire()).toBe(true);
    expect(await store.unlockedAccounts()).toEqual([]);
  });

  it('migrates the existing single-session slot without reauthentication', async () => {
    const { store, values, a } = fixture();
    await store.start(a);
    delete values['coffer.sessions'];
    await store.select(null);
    expect(await store.select(a.account)).toEqual(a);
  });

  it('does not return a stale key from a read spanning an account selection', async () => {
    const { store, area, a, b } = fixture();
    await store.start(a);
    const get = area.get;
    let finish!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    area.get = async (keys) => {
      const value = await get(keys);
      if (keys === 'coffer.session') { started(); await new Promise<void>((resolve) => { finish = resolve; }); }
      return value;
    };
    const reading = store.load(); await waiting;
    await store.select(b.account);
    finish();
    expect(await reading).toBeNull();
  });

  it('clears the explicit selected identity when selection storage is still pending', async () => {
    const { store, area, a, b } = fixture();
    await store.start(a); await store.select(b.account); await store.start(b); await store.select(a.account);
    const get = area.get;
    let finish!: () => void;
    let started!: () => void;
    let pause = true;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    area.get = async (keys) => {
      const value = await get(keys);
      if (pause && Array.isArray(keys) && keys.length === 2) {
        pause = false; started(); await new Promise<void>((resolve) => { finish = resolve; });
      }
      return value;
    };
    const selecting = store.select(b.account);
    const cancelled = expect(selecting).rejects.toThrow();
    await waiting;
    const clearing = store.clear({ forgetAccount: true, account: b.account });
    finish(); await clearing; await cancelled;
    expect(await store.select(b.account)).toBeNull();
    expect(await store.select(a.account)).toEqual(a);
  });

  it('lets newer selection supersede an in-flight expiry read', async () => {
    const { store, area, a, b, advance } = fixture();
    await store.start(a); advance(100); await store.select(b.account); await store.start(b); await store.select(a.account);
    advance(SESSION_DURATION_MS - 50);
    const get = area.get;
    let finish!: () => void;
    let started!: () => void;
    let pause = true;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    area.get = async (keys) => {
      const value = await get(keys);
      if (pause && Array.isArray(keys)) { pause = false; started(); await new Promise<void>((resolve) => { finish = resolve; }); }
      return value;
    };
    const expiring = store.expire(); await waiting;
    const selecting = store.select(b.account);
    finish(); await expiring;
    expect(await selecting).toEqual(b);
  });
});
