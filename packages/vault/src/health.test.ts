import { describe, it, expect, vi } from 'vitest';
import {
  findReusedPasswords, findWeakPasswords, findUnsecuredSites, findExpiring,
  securityScore, checkBreaches, hibpPrefix,
} from './health';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function login(id: string, password: string | null, uri?: string, extra: Partial<VaultItem> = {}): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), password, uris: uri ? [{ uri, match: null }] : [] },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...extra,
  };
}

describe('findReusedPasswords', () => {
  it('groups items sharing the same password', () => {
    const groups = findReusedPasswords([
      login('a', 'same'), login('b', 'same'), login('c', 'unique'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.itemIds.sort()).toEqual(['a', 'b']);
  });

  it('ignores null and empty passwords', () => {
    expect(findReusedPasswords([login('a', null), login('b', null), login('c', '')])).toEqual([]);
  });

  // 只出现一次的密码不算重复 —— 否则报告会给每个正常用户报 100 条
  it('does not report a password used only once', () => {
    expect(findReusedPasswords([login('a', 'only-once')])).toEqual([]);
  });

  it('returns groups sorted by how many items share the password', () => {
    const groups = findReusedPasswords([
      login('a', 'x'), login('b', 'x'), login('c', 'x'),
      login('d', 'y'), login('e', 'y'),
    ]);
    expect(groups[0]?.itemIds).toHaveLength(3);
  });

  it('skips deleted and archived items', () => {
    const groups = findReusedPasswords([
      login('a', 'same'), login('b', 'same', undefined, { deletedAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('findWeakPasswords', () => {
  it('flags short and common passwords', () => {
    const ids = findWeakPasswords([
      login('a', '123456'), login('b', 'password'), login('c', 'kJ8#mPq2$vXn9!wZt4&bR'),
    ]).map((f) => f.itemId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
  });

  // ⚠️ 纯字符类熵会把 P@ssw0rd1! 算成「强」。必须做词根还原再查表，
  // 否则字典密码加个后缀就被报成安全 —— 这比不报还糟，用户会以为已经改好了。
  it('flags dictionary words with common substitutions', () => {
    const ids = findWeakPasswords([login('a', 'P@ssw0rd1!'), login('b', 'Password1!')]).map((f) => f.itemId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('flags digits-only and single repeated characters', () => {
    const ids = findWeakPasswords([login('a', '9382716450'), login('b', 'aaaaaaaaaa')]).map((f) => f.itemId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('does not flag a long random password', () => {
    expect(findWeakPasswords([login('a', 'kJ8#mPq2$vXn9!wZt4&bR')])).toEqual([]);
  });

  it('skips deleted items', () => {
    expect(findWeakPasswords([login('a', '123456', undefined, { deletedAt: '2026-01-01T00:00:00Z' })])).toEqual([]);
  });
});

describe('findUnsecuredSites', () => {
  it('flags http:// uris', () => {
    expect(findUnsecuredSites([login('a', 'p', 'http://example.com')]).map((i) => i.id)).toEqual(['a']);
  });

  it('does not flag https:// or scheme-less uris', () => {
    expect(findUnsecuredSites([login('a', 'p', 'https://example.com')])).toEqual([]);
    expect(findUnsecuredSites([login('b', 'p', 'example.com')])).toEqual([]);
  });
});

describe('findExpiring', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  function card(id: string, expMonth: string, expYear: string): VaultItem {
    return {
      ...login(id, null), type: 'card', rawType: 3, login: null,
      card: { cardholderName: null, brand: 'Visa', number: null, expMonth, expYear, code: null },
    };
  }

  it('flags a card expiring within two months', () => {
    expect(findExpiring([card('c', '7', '2026')], now).map((f) => f.itemId)).toEqual(['c']);
  });

  it('does not flag a card expiring far in the future', () => {
    expect(findExpiring([card('c', '1', '2030')], now)).toEqual([]);
  });

  it('flags an already-expired card', () => {
    expect(findExpiring([card('c', '1', '2020')], now).map((f) => f.itemId)).toEqual(['c']);
  });

  // 有效期到当月**最后一天**，不是当月第一天 —— 差一个月会让用户提前换卡
  it('treats the expiry as the last day of the month', () => {
    const f = findExpiring([card('c', '6', '2026')], now)[0];
    expect(f?.expiresAt.startsWith('2026-06-30')).toBe(true);
  });

  it('skips cards with unparseable expiry rather than crashing', () => {
    expect(() => findExpiring([card('c', 'abc', 'x')], now)).not.toThrow();
    expect(findExpiring([card('c', 'abc', 'x')], now)).toEqual([]);
    // 月份越界同样跳过
    expect(findExpiring([card('c', '13', '2026')], now)).toEqual([]);
  });
});

describe('securityScore', () => {
  // 官方从未文档化它的量表 —— 我们自己定一套并写清楚，不假装复刻
  it('gives a high score to a clean vault', () => {
    expect(securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 100 }).score)
      .toBeGreaterThan(85);
  });

  it('gives a low score when most items have problems', () => {
    expect(securityScore({ reused: 20, weak: 20, breached: 20, unsecured: 20, total: 100 }).score)
      .toBeLessThan(40);
  });

  it('never goes below zero or above 100', () => {
    expect(securityScore({ reused: 999, weak: 999, breached: 999, unsecured: 999, total: 1 }).score).toBe(0);
    expect(securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 0 }).score)
      .toBeLessThanOrEqual(100);
  });

  it('handles an empty vault without dividing by zero', () => {
    expect(Number.isFinite(securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 0 }).score))
      .toBe(true);
  });
});

describe('HIBP k-匿名', () => {
  it('splits a SHA-1 hash into a 5-char prefix and the rest, uppercased', async () => {
    const { prefix, suffix } = await hibpPrefix('password');
    expect(prefix).toHaveLength(5);
    expect(prefix).toBe(prefix.toUpperCase());
    expect(suffix).toBe(suffix.toUpperCase());
    expect(prefix + suffix).toHaveLength(40);
  });

  it('produces the known SHA-1 of "password"', async () => {
    const { prefix, suffix } = await hibpPrefix('password');
    expect(prefix + suffix).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  /**
   * ⚠️ 这是整个功能能被接受的前提：**离开设备的只有 5 个字符**。
   * 一旦完整哈希被发出去，k-匿名就名存实亡。
   */
  it('only ever sends the 5-char prefix', async () => {
    // 显式写出参数类型：否则 mock 的 calls 元组是空的，取不到 [0]
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response('5BAA6:1\nOTHER:99', { status: 200 }));
    await checkBreaches([login('a', 'password')], { fetchImpl });

    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/range/5BAA6');
    expect(url).not.toContain('1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('flags a password whose suffix appears in the range response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345', { status: 200 }));
    expect((await checkBreaches([login('a', 'password')], { fetchImpl })).map((f) => f.itemId))
      .toEqual(['a']);
  });

  it('does not flag a password whose suffix is absent', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1', { status: 200 }));
    expect(await checkBreaches([login('a', 'password')], { fetchImpl })).toEqual([]);
  });

  it('records how many times the password appeared in breaches', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345', { status: 200 }));
    expect((await checkBreaches([login('a', 'password')], { fetchImpl }))[0]?.count).toBe(12345);
  });

  // 少一项报告，好过整个页面挂掉
  it('survives a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(checkBreaches([login('a', 'password')], { fetchImpl })).resolves.toEqual([]);
  });

  it('skips items without a password', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await checkBreaches([login('a', null)], { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** 结果会被序列化送进界面，密码本身绝不能在里面 */
  it('never leaks the password into the result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:5', { status: 200 }));
    const found = await checkBreaches([login('a', 'password')], { fetchImpl });
    expect(JSON.stringify(found)).not.toContain('password');
  });
});
