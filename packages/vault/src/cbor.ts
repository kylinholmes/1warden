/**
 * CBOR 编码 —— 只做 WebAuthn 需要的那一小块。
 *
 * ## 为什么自己写
 *
 * 需要的只有整数、字节串、文本、数组、映射五种类型，加起来一百来行。
 * 引一个通用 CBOR 库要连带解码器、流式 API、标签支持等一大堆用不上的东西，
 * 而这里**每一处都必须可验证** —— attestationObject 的字节布局错一个，
 * 注册就会在某个 RP 上失败，且报错通常只有一句「invalid attestation」。
 *
 * ## ⚠️ 规范序（canonical / CTAP2 ordering）
 *
 * 映射的键**必须**先按「编码后的字节长度」排序，长度相同再按字节序。
 * 这是 CTAP2 的硬要求，不是风格问题：不合规范序的 CBOR 会被严格的验证方拒绝，
 * 而普通解析器照样能读出来 —— 于是这个错误只会在部分 RP 上出现，
 * 本地怎么试都是好的，极难复现。
 */

/** CBOR 的主要类型（高 3 位） */
const MT_UINT = 0;
const MT_NINT = 1;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;

/** 已编码好的一个 CBOR 数据项 */
export interface CborValue {
  /** 编码后的字节 */
  readonly bytes: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * 写出「主要类型 + 长度」的头几个字节。
 *
 * 长度用**最短**的那个形式：0–23 直接放进低 5 位；24–255 用 1 字节；
 * 256–65535 用 2 字节；再往上 4 字节、8 字节。用长形式编码一个小数字
 * 同样是不合规范序的（那叫「非最短形式」）。
 */
function head(major: number, value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`CBOR 长度必须是非负整数，收到 ${value}`);
  }
  const mt = major << 5;

  if (value < 24) return new Uint8Array([mt | value]);
  if (value < 0x100) return new Uint8Array([mt | 24, value]);
  if (value < 0x10000) return new Uint8Array([mt | 25, value >> 8, value & 0xff]);
  if (value < 0x100000000) {
    return new Uint8Array([mt | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }
  // 2^32 以上这里用不到（WebAuthn 里没有这种长度），明确报错好过写出错的字节
  throw new Error(`CBOR 长度超出支持范围：${value}`);
}

export function cborInt(n: number): CborValue {
  if (!Number.isInteger(n)) throw new Error(`CBOR 整数不能有小数部分：${n}`);
  // 负数编码成 -(n+1)：-1 → 0，-7 → 6
  return { bytes: n >= 0 ? head(MT_UINT, n) : head(MT_NINT, -n - 1) };
}

export function cborBytes(b: Uint8Array): CborValue {
  return { bytes: concat([head(MT_BYTES, b.length), b]) };
}

export function cborText(s: string): CborValue {
  // ⚠️ 长度按 **UTF-8 字节数**算，不是字符数 —— 中文一个字 3 字节
  const utf8 = new TextEncoder().encode(s);
  return { bytes: concat([head(MT_TEXT, utf8.length), utf8]) };
}

export function cborArray(items: readonly CborValue[]): CborValue {
  return { bytes: concat([head(MT_ARRAY, items.length), ...items.map((i) => i.bytes)]) };
}

/**
 * 映射。键会**自动**排成规范序 —— 交给调用方去排迟早会漏。
 */
export function cborMap(entries: readonly (readonly [CborValue, CborValue])[]): CborValue {
  const sorted = [...entries].sort((a, b) => {
    const [ka, kb] = [a[0].bytes, b[0].bytes];
    if (ka.length !== kb.length) return ka.length - kb.length;   // 先比长度
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;                // 再比字节
    }
    return 0;
  });
  return {
    bytes: concat([
      head(MT_MAP, sorted.length),
      ...sorted.flatMap(([k, v]) => [k.bytes, v.bytes]),
    ]),
  };
}

export function encodeCbor(v: CborValue): Uint8Array {
  return v.bytes;
}
