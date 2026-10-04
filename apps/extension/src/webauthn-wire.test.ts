import { describe, it, expect } from 'vitest';
import { bytesFromB64url, b64urlFromBytes, asBytes, serializeAllow, type AllowDescriptor } from './webauthn-wire';

// 标准算法，不依赖 Buffer（扩展的 tsconfig 不带 node 类型）。
// 用 btoa 而不是被测代码里的实现，是为了让「期望值」来自另一条路径
const b64url = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 一段 32 字节的伪随机数据 —— 长度与真实凭据 ID 一致 */
const RAW = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const ID = b64url(RAW);

describe('base64url 往返', () => {
  it('round-trips 32 bytes without padding', () => {
    expect(bytesFromB64url(ID)).toHaveLength(32);
    expect(b64urlFromBytes(bytesFromB64url(ID))).toBe(ID);
    expect(ID).not.toContain('=');
  });

  /** ⚠️ 32 字节编出来是 43 个字符，**不是 4 的倍数** —— `atob` 需要补一个 `=` */
  it('handles the padding that atob requires', () => {
    expect(ID).toHaveLength(43);
    expect(bytesFromB64url(ID)).toEqual(RAW);
  });

  it('round-trips every length from 0 to 64', () => {
    for (let n = 0; n <= 64; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff);
      expect(bytesFromB64url(b64urlFromBytes(b))).toEqual(b);
    }
  });
});

describe('asBytes —— 页面可能拿什么类型当 ID', () => {
  it('accepts an ArrayBuffer', () => {
    expect(asBytes(RAW.buffer.slice(0))).toEqual(RAW);
  });

  it('accepts a Uint8Array', () => {
    expect(asBytes(RAW)).toEqual(RAW);
  });

  /** 有的库会传普通数组 */
  it('accepts a plain number array', () => {
    expect(asBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
  });

  /** 视图可能只是某个大 buffer 的一段 —— 必须尊重 byteOffset */
  it('respects byteOffset on a view into a larger buffer', () => {
    const big = new Uint8Array([9, 9, ...RAW, 9, 9]);
    const view = new Uint8Array(big.buffer, 2, 32);
    expect(asBytes(view)).toEqual(RAW);
  });

  it('rejects anything else', () => {
    expect(asBytes('not bytes')).toBeNull();
    expect(asBytes(null)).toBeNull();
    expect(asBytes(undefined)).toBeNull();
    expect(asBytes({})).toBeNull();
  });
});

/**
 * ⚠️ 这一段是把「页面给的凭据 ID」翻译成我们内部用的 base64url。
 *
 * 它是 passkey 登录路径上唯一的一处翻译，而**页面几乎总是会指定
 * allowCredentials** —— 也就是说这条链错了，passkey 就等于是不可用的。
 *
 * 这才是重点：它是纯逻辑、可以在 node 里跑，所以没有理由把它留在
 * 那个只能用浏览器跑起来的 IIFE 里靠猜。之前那版就是这么错的。
 */
describe('serializeAllow —— 页面指定凭据时的翻译', () => {
  it('turns a Uint8Array id into the same base64url we store', () => {
    const got = serializeAllow([{ type: 'public-key', id: bytesFromB64url(ID) }]);
    expect(got).toEqual([{ id: ID, type: 'public-key' }]);
  });

  it('accepts an ArrayBuffer id', () => {
    expect(serializeAllow([{ type: 'public-key', id: RAW.buffer.slice(0) }]))
      .toEqual([{ id: ID, type: 'public-key' }]);
  });

  /** 空数组**不是**「没有限制」—— 要原样传下去，由匹配层当成空集处理 */
  it('keeps a non-empty list in order', () => {
    const a = bytesFromB64url(b64url(Uint8Array.from([1, 2, 3])));
    const b = bytesFromB64url(b64url(Uint8Array.from([4, 5, 6])));
    const got = serializeAllow([
      { type: 'public-key', id: a },
      { type: 'public-key', id: b },
    ]);
    expect(got?.map((d) => d.id)).toEqual([b64url(Uint8Array.from([1, 2, 3])), b64url(Uint8Array.from([4, 5, 6]))]);
  });

  it('returns an empty list for an empty list', () => {
    expect(serializeAllow([])).toEqual([]);
  });

  it('returns null when the page did not specify allowCredentials', () => {
    expect(serializeAllow(null)).toBeNull();
    expect(serializeAllow(undefined)).toBeNull();
  });

  it('defaults a missing type to public-key', () => {
    const got = serializeAllow([{ id: bytesFromB64url(ID) }]);
    expect(got?.[0]?.type).toBe('public-key');
  });

  /** 认不出来的条目跳过，而不是让它把整次调用带崩 —— 登录不该因为一条坏数据全废 */
  it('skips an entry whose id is not bytes', () => {
    const got = serializeAllow([{ id: 'nope' }, { id: bytesFromB64url(ID) }]);
    expect(got).toEqual([{ id: ID, type: 'public-key' }]);
  });

  it('parses but drops non-object entries', () => {
    expect(serializeAllow([null, 42, { id: bytesFromB64url(ID) }])).toEqual([{ id: ID, type: 'public-key' }]);
  });
});

describe('AllowDescriptor 的形状', () => {
  it('carries transports through when present', () => {
    const d: AllowDescriptor = { id: ID, type: 'public-key', transports: ['internal'] };
    expect(serializeAllow([{ ...d, id: bytesFromB64url(ID) }])?.[0]?.transports).toEqual(['internal']);
  });
});
