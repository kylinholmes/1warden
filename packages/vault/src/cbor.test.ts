import { describe, it, expect } from 'vitest';
import { encodeCbor, cborText, cborBytes, cborInt, cborArray, cborMap } from './cbor';

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('CBOR 整数', () => {
  // RFC 8949 附录 A 的官方向量
  it('encodes small integers in the shortest form', () => {
    expect(hex(encodeCbor(cborInt(0)))).toBe('00');
    expect(hex(encodeCbor(cborInt(1)))).toBe('01');
    expect(hex(encodeCbor(cborInt(10)))).toBe('0a');
    expect(hex(encodeCbor(cborInt(23)))).toBe('17');
  });

  it('switches to the next length at 24', () => {
    expect(hex(encodeCbor(cborInt(24)))).toBe('1818');
    expect(hex(encodeCbor(cborInt(255)))).toBe('18ff');
    expect(hex(encodeCbor(cborInt(256)))).toBe('190100');
    expect(hex(encodeCbor(cborInt(65535)))).toBe('19ffff');
    expect(hex(encodeCbor(cborInt(65536)))).toBe('1a00010000');
  });

  /** ⚠️ COSE 的 alg / crv 都是负数（ES256 = -7），编码错了整个公钥就废了 */
  it('encodes negatives with the major type 1 form', () => {
    expect(hex(encodeCbor(cborInt(-1)))).toBe('20');
    expect(hex(encodeCbor(cborInt(-7)))).toBe('26');
    expect(hex(encodeCbor(cborInt(-8)))).toBe('27');
    expect(hex(encodeCbor(cborInt(-24)))).toBe('37');
    expect(hex(encodeCbor(cborInt(-25)))).toBe('3818');
  });

  it('rejects a non-integer instead of silently truncating', () => {
    expect(() => cborInt(1.5)).toThrow();
  });
});

describe('CBOR 字节串与文本', () => {
  it('encodes a byte string with its length', () => {
    expect(hex(encodeCbor(cborBytes(new Uint8Array([]))))).toBe('40');
    expect(hex(encodeCbor(cborBytes(new Uint8Array([1, 2, 3]))))).toBe('43010203');
  });

  it('encodes text as UTF-8', () => {
    expect(hex(encodeCbor(cborText('a')))).toBe('6161');
    expect(hex(encodeCbor(cborText('IETF')))).toBe('6449455446');
    // 中文按 UTF-8 字节数算长度，不是字符数
    expect(hex(encodeCbor(cborText('中')))).toBe('63e4b8ad');
  });

  it('uses the 1-byte length form at 24 bytes and above', () => {
    expect(hex(encodeCbor(cborBytes(new Uint8Array(23))))).toBe('57' + '00'.repeat(23));
    expect(hex(encodeCbor(cborBytes(new Uint8Array(24))))).toBe('5818' + '00'.repeat(24));
  });
});

describe('CBOR 数组与映射', () => {
  it('encodes arrays', () => {
    expect(hex(encodeCbor(cborArray([cborInt(1), cborInt(2)])))).toBe('820102');
    expect(hex(encodeCbor(cborArray([])))).toBe('80');
  });

  it('encodes maps', () => {
    expect(hex(encodeCbor(cborMap([[cborInt(1), cborInt(2)]])))).toBe('a10102');
    expect(hex(encodeCbor(cborMap([])))).toBe('a0');
  });

  /**
   * ⚠️ CTAP2 要求**规范序**：键先按编码后的字节长度排，长度相同再按字节序。
   * 不合规范序的 CBOR 会被严格的验证方拒绝 —— 而普通解析器照样能读，
   * 所以这个错误只会在某些 RP 上出现，极难复现。
   */
  it('sorts map keys into canonical order', () => {
    // 1 与 24：24 编码成两字节，排在后面
    expect(hex(encodeCbor(cborMap([[cborInt(24), cborInt(0)], [cborInt(1), cborInt(0)]]))))
      .toBe('a20100181800');
    // 同为 1 字节时按字节序
    expect(hex(encodeCbor(cborMap([[cborInt(2), cborInt(0)], [cborInt(1), cborInt(0)]]))))
      .toBe('a201000200');
  });

  it('sorts COSE key integers correctly', () => {
    // COSE 公钥的键 1, 3, -1, -2, -3 都编码成单个字节：01 03 20 21 22，
    // 长度相同，按字节序排 —— 恰好就是 1 < 3 < -1 < -2 < -3
    const m = cborMap([
      [cborInt(-2), cborBytes(new Uint8Array([2]))],
      [cborInt(1), cborInt(2)],
      [cborInt(-1), cborInt(1)],
      [cborInt(3), cborInt(-7)],
      [cborInt(-3), cborBytes(new Uint8Array([3]))],
    ]);
    expect(hex(encodeCbor(m))).toBe('a5010203262001214102224103');
  });

  it('encodes nested structures', () => {
    const nested = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(new Uint8Array([0xaa]))],
    ]);
    // 三个键按编码后的长度排：fmt(4 字节) < attStmt(8) < authData(9)，
    // 所以 fmt 在最前
    expect(hex(encodeCbor(nested)).startsWith('a36366')).toBe(true);
  });
});
