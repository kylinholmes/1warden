import { describe, it, expect } from 'vitest';
import {
  parseEncString, serializeEncString, DecryptError,
  aesCbcEncrypt, aesCbcDecrypt, hmacSha256,
} from './encstring';
import { toBase64, utf8Encode, utf8Decode } from './bytes';

/** RFC 4231 用十六进制给出答案，转成 hex 比较才是同一把尺子 */
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('EncString parsing', () => {
  it('parses a type-2 string', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    const p = parseEncString(s);
    expect(p.type).toBe(2);
    expect(p.iv).toHaveLength(16);
    expect(p.data).toHaveLength(8);
    expect(p.mac).toHaveLength(32);
  });

  it('parses a type-0 string with no MAC segment', () => {
    const s = `0.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(4))}`;
    const p = parseEncString(s);
    expect(p.type).toBe(0);
    expect(p.mac).toBeUndefined();
  });

  it('parses a type-4 string (RSA, no IV)', () => {
    const p = parseEncString(`4.${toBase64(new Uint8Array(256))}`);
    expect(p.type).toBe(4);
    expect(p.iv).toBeUndefined();
    expect(p.data).toHaveLength(256);
  });

  it('round-trips through serialize', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    const p = parseEncString(s);
    expect(serializeEncString(p.type, p.iv, p.data, p.mac)).toBe(s);
  });

  it('throws DecryptError(malformed) on a missing separator', () => {
    try { parseEncString('2.abc'); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).kind).toBe('malformed');
    }
  });

  it('throws DecryptError on a non-numeric type', () => {
    expect(() => parseEncString('x.a|b')).toThrow(DecryptError);
  });

  it('throws DecryptError(malformed) on wrong IV length', () => {
    const s = `2.${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    try { parseEncString(s); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('malformed'); }
  });

  it('throws DecryptError(malformed) on wrong MAC length', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(16))}`;
    try { parseEncString(s); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('malformed'); }
  });

  it('rejects an unknown type number', () => {
    try { parseEncString(`9.${toBase64(new Uint8Array(4))}`); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('unsupportedType'); }
  });

  // ⚠️ Bitwarden 的字段大量是 null / 缺失（没填的用户名、空的 notes）。
  // 解密循环一定会遇到 null。若这里抛的是 TypeError 而不是 DecryptError，
  // 调用方无法按类型分流，一个字段就能让整条条目（甚至整个保险库）解密中断。
  it('throws DecryptError (not TypeError) for null / undefined / non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => parseEncString(bad as unknown as string), `输入 ${JSON.stringify(bad)}`)
        .toThrow(DecryptError);
    }
  });

  it('throws DecryptError for an empty string', () => {
    expect(() => parseEncString('')).toThrow(DecryptError);
  });
});

describe('AES-CBC + HMAC primitives', () => {
  it('round-trips through AES-256-CBC with PKCS#7 padding', async () => {
    const key = new Uint8Array(32).fill(1);
    const iv = new Uint8Array(16).fill(2);
    const pt = utf8Encode('hello world');
    const ct = await aesCbcEncrypt(key, iv, pt);
    expect(ct.length % 16).toBe(0);
    expect(utf8Decode(await aesCbcDecrypt(key, iv, ct))).toBe('hello world');
  });

  it('round-trips an empty plaintext', async () => {
    const key = new Uint8Array(32).fill(1), iv = new Uint8Array(16).fill(2);
    const ct = await aesCbcEncrypt(key, iv, new Uint8Array(0));
    expect(ct).toHaveLength(16); // PKCS#7 对空串补满一整块
    expect(await aesCbcDecrypt(key, iv, ct)).toEqual(new Uint8Array(0));
  });

  it('round-trips Chinese text', async () => {
    const key = new Uint8Array(32).fill(1), iv = new Uint8Array(16).fill(2);
    const pt = utf8Encode('我的密码🔐 与中文');
    expect(utf8Decode(await aesCbcDecrypt(key, iv, await aesCbcEncrypt(key, iv, pt)))).toBe('我的密码🔐 与中文');
  });

  it('rejects a ciphertext whose length is not a multiple of 16', async () => {
    const key = new Uint8Array(32).fill(1), iv = new Uint8Array(16).fill(2);
    await expect(aesCbcDecrypt(key, iv, new Uint8Array(15))).rejects.toBeInstanceOf(DecryptError);
  });

  // RFC 4231 §4.2 —— 有官方答案的 HMAC 测试
  it('computes HMAC-SHA256 correctly (RFC 4231 test case 1)', async () => {
    const mac = await hmacSha256(new Uint8Array(20).fill(0x0b), utf8Encode('Hi There'));
    expect(toHex(mac)).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('computes HMAC-SHA256 correctly (RFC 4231 test case 2)', async () => {
    const mac = await hmacSha256(utf8Encode('Jefe'), utf8Encode('what do ya want for nothing?'));
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('handles an empty message (RFC 4231 test case 7 shape)', async () => {
    const mac = await hmacSha256(new Uint8Array(20).fill(0x0b), new Uint8Array(0));
    expect(mac).toHaveLength(32);
  });
});
