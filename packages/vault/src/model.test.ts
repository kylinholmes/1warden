import { describe, it, expect } from 'vitest';
import { cipherTypeToItemType, emptyLogin, emptyCard, emptyIdentity, ITEM_TYPES } from './model';

describe('cipherTypeToItemType', () => {
  it('maps the five types we handle natively', () => {
    expect(cipherTypeToItemType(1)).toBe('login');
    expect(cipherTypeToItemType(2)).toBe('secureNote');
    expect(cipherTypeToItemType(3)).toBe('card');
    expect(cipherTypeToItemType(4)).toBe('identity');
    expect(cipherTypeToItemType(5)).toBe('sshKey');
  });

  // ⚠️ 6/7/8 是 2026 年新增的，老服务端不认识。
  // 按接口稳定性原则：收到时按「未知类型」只读展示，不提供编辑。
  it('treats the newer types 6-8 as unknown rather than crashing', () => {
    expect(cipherTypeToItemType(6)).toBe('unknown');
    expect(cipherTypeToItemType(7)).toBe('unknown');
    expect(cipherTypeToItemType(8)).toBe('unknown');
  });

  it('treats any out-of-range type as unknown', () => {
    expect(cipherTypeToItemType(0)).toBe('unknown');
    expect(cipherTypeToItemType(99)).toBe('unknown');
    expect(cipherTypeToItemType(-1)).toBe('unknown');
    expect(cipherTypeToItemType(1.5)).toBe('unknown');
  });
});

describe('emptyLogin / emptyCard / emptyIdentity', () => {
  it('produces fully-null field shapes so the editor never hits undefined', () => {
    expect(emptyLogin().username).toBeNull();
    expect(emptyLogin().uris).toEqual([]);
    expect(emptyCard().number).toBeNull();
    expect(emptyIdentity().ssn).toBeNull();
    expect(Object.values(emptyIdentity()).every((v) => v === null)).toBe(true);
  });

  // 共享可变状态会让两条条目互相污染 —— 每次都返回新对象
  it('returns a fresh object each call', () => {
    const a = emptyLogin(), b = emptyLogin();
    a.uris.push({ uri: 'x', match: null });
    expect(b.uris).toEqual([]);
  });
});

describe('ITEM_TYPES', () => {
  it('lists every item type exactly once', () => {
    expect(new Set(ITEM_TYPES).size).toBe(ITEM_TYPES.length);
    expect(ITEM_TYPES).toContain('unknown');
  });
});
