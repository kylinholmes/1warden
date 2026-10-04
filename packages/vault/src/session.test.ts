import { describe, it, expect, vi } from 'vitest';
import { makeUserKey } from '@coffer/crypto';
import { VaultSession } from './session';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function fakeItem(id: string, password: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), username: 'u', password },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const account = { serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0 as const, iterations: 1000 } };

function unlocked(): VaultSession {
  const s = new VaultSession();
  s.setAccount(account);
  return s;
}

describe('VaultSession — 状态机', () => {
  it('starts logged out with nothing loaded', () => {
    const s = new VaultSession();
    expect(s.status).toBe('loggedOut');
    expect(s.items).toEqual([]);
    expect(s.isUnlocked()).toBe(false);
  });

  it('moves locked → unlocking → unlocked', () => {
    const seen: string[] = [];
    const s = new VaultSession({ onStatusChange: (st) => seen.push(st) });
    s.setAccount(account);
    s.beginUnlock();
    expect(s.status).toBe('unlocking');
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'pw')], []);
    expect(s.status).toBe('unlocked');
    expect(seen).toEqual(['locked', 'unlocking', 'unlocked']);
  });

  it('rejects completeUnlock unless unlocking', () => {
    expect(() => unlocked().completeUnlock(makeUserKey(), [], [])).toThrow(/unlocking/i);
  });

  it('rejects beginUnlock before an account is set', () => {
    expect(() => new VaultSession().beginUnlock()).toThrow(/账户/);
  });
});

describe('VaultSession — lock 必须清空一切', () => {
  it('clears items, folders and keys', () => {
    const s = unlocked();
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'secret')],
      [{ id: 'f1', name: '工作', nameFailed: false, updatedAt: 'x' }]);

    expect(s.items).toHaveLength(1);
    s.lock();
    expect(s.status).toBe('locked');
    expect(s.items).toEqual([]);
    expect(s.folders).toEqual([]);
    expect(s.getKey()).toBeNull();
    expect(s.isUnlocked()).toBe(false);
  });

  // ⚠️ S5 的核心：锁之后通过 session 不能再读到任何明文
  it('exposes no plaintext after locking', () => {
    const s = unlocked();
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'secret')], []);
    expect(s.items[0]?.login?.password).toBe('secret');
    s.lock();
    expect(s.items).toEqual([]);
  });

  it('zeroizes the key buffer on lock', () => {
    const s = unlocked();
    s.beginUnlock();
    const k = makeUserKey();
    s.completeUnlock(k, [], []);
    s.lock();
    // 缓冲区被就地覆写为 0 —— 这是 JS 里能做到的最好程度
    expect(k.encKey.every((b) => b === 0)).toBe(true);
    expect(k.macKey.every((b) => b === 0)).toBe(true);
  });

  it('fires onLock once per unlock→lock cycle', () => {
    const onLock = vi.fn();
    const s = new VaultSession({ onLock });
    s.setAccount(account);
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    s.lock();
    expect(onLock).toHaveBeenCalledTimes(1);
    s.lock();
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('is safe to lock when already logged out', () => {
    expect(() => new VaultSession().lock()).not.toThrow();
  });

  it('logout clears the account too', () => {
    const s = unlocked();
    s.logout();
    expect(s.status).toBe('loggedOut');
    expect(s.account).toBeNull();
  });
});

describe('VaultSession — 自动锁定', () => {
  it('locks after the configured idle period', () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 1000 });
    s.setAccount(account);
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    vi.advanceTimersByTime(1001);
    expect(s.status).toBe('locked');
    vi.useRealTimers();
  });

  it('resets the idle timer on activity', () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 1000 });
    s.setAccount(account);
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    vi.advanceTimersByTime(800);
    s.touchActivity();
    vi.advanceTimersByTime(800);
    expect(s.status).toBe('unlocked');
    vi.advanceTimersByTime(300);
    expect(s.status).toBe('locked');
    vi.useRealTimers();
  });

  it('does not auto-lock when autoLockMs is zero', () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 0 });
    s.setAccount(account);
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    vi.advanceTimersByTime(1_000_000);
    expect(s.status).toBe('unlocked');
    vi.useRealTimers();
  });

  it('cancels the timer on manual lock so it cannot fire later', () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const s = new VaultSession({ autoLockMs: 1000, onLock });
    s.setAccount(account);
    s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    s.lock();
    vi.advanceTimersByTime(5000);
    expect(onLock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not auto-lock while merely unlocking', () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 1000 });
    s.setAccount(account);
    s.beginUnlock();
    vi.advanceTimersByTime(5000);
    expect(s.status).toBe('unlocking');
    vi.useRealTimers();
  });
});

describe('VaultSession — replaceData 只在解锁态生效', () => {
  it('ignores replaceData when locked (a late sync must not resurrect data)', () => {
    const s = unlocked();
    s.replaceData([fakeItem('1', 'late')], []);
    expect(s.items).toEqual([]);
  });
});
