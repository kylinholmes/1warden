import { describe, it, expect } from 'vitest';
import {
  stretchMasterKey, makeUserKey, encryptString, decryptString,
  encryptBytes, decryptBytes, zeroizeKey,
} from './keys';
import { toBase64, utf8Encode, fromBase64 } from './bytes';
import { DecryptError } from './encstring';

// 测试辅助
function fromHex(s: string): Uint8Array {
  return new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
}
function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('stretchMasterKey', () => {
  it('produces 32-byte enc and mac keys', async () => {
    const k = await stretchMasterKey(new Uint8Array(32).fill(9));
    expect(k.encKey).toHaveLength(32);
    expect(k.macKey).toHaveLength(32);
  });

  it('is deterministic', async () => {
    const mk = new Uint8Array(32).fill(9);
    const a = await stretchMasterKey(mk), b = await stretchMasterKey(mk);
    expect(a.encKey).toEqual(b.encKey);
    expect(a.macKey).toEqual(b.macKey);
  });

  it('produces different enc and mac keys (info string separation)', async () => {
    const k = await stretchMasterKey(new Uint8Array(32).fill(9));
    expect(k.encKey).not.toEqual(k.macKey);
  });

  it('matches the HKDF-Expand definition', async () => {
    // 独立复算 T(1) = HMAC-SHA256(PRK, "enc" || 0x01)
    const mk = new Uint8Array(32).fill(9);
    const hmacKey = await crypto.subtle.importKey('raw', mk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const info = new Uint8Array([...utf8Encode('enc'), 0x01]);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, info));
    expect((await stretchMasterKey(mk)).encKey).toEqual(expected);
  });

  // 🔑 官方测试向量 —— 唯一的「外部权威答案」。
  // 来源：bitwarden/sdk-internal, crates/bitwarden-crypto/src/keys/utils.rs::test_stretch_kdf_key
  // 这一条能同时抓住：HMAC 用错、info 串写错、enc/mac 顺序颠倒，
  // 以及最阴险的「误用 WebCrypto 的 extract+expand HKDF」（那样两个值都会不同）。
  it('matches the official stretch_key test vector', async () => {
    const masterKey = fromHex('1f4f68e29647b15ac250acd1118184518aa745a7fe95021b27c5402a16c3564b');
    const k = await stretchMasterKey(masterKey);
    expect(toHex(k.encKey)).toBe('6f1fb22dee9825728fd77c5387adc3178e8678f93d84a3b671c5bdccbc15ed60');
    expect(toHex(k.macKey)).toBe('dd7fceea651bca265634221c4e1cb910303d7fa6d1f7c257e81a3055c1f9b39b');
  });
});

describe('makeUserKey', () => {
  it('produces 32-byte keys and is random per call', () => {
    const a = makeUserKey(), b = makeUserKey();
    expect(a.encKey).toHaveLength(32);
    expect(a.macKey).toHaveLength(32);
    expect(a.encKey).not.toEqual(b.encKey);
  });
});

describe('symmetric encrypt/decrypt', () => {
  const key = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

  it('round-trips a string as a type-2 EncString', async () => {
    const enc = await encryptString('hello', key);
    expect(enc.startsWith('2.')).toBe(true);
    expect(await decryptString(enc, key)).toBe('hello');
  });

  it('round-trips an empty string', async () => {
    expect(await decryptString(await encryptString('', key), key)).toBe('');
  });

  it('round-trips Chinese text and emoji', async () => {
    const s = '我的密码🔐!@#$%^&*()';
    expect(await decryptString(await encryptString(s, key), key)).toBe(s);
  });

  it('round-trips a long string', async () => {
    const s = 'x'.repeat(100_000);
    expect(await decryptString(await encryptString(s, key), key)).toBe(s);
  });

  it('uses a fresh IV every time (no deterministic ciphertext)', async () => {
    expect(await encryptString('same', key)).not.toBe(await encryptString('same', key));
  });

  it('round-trips raw bytes', async () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
    expect(await decryptBytes(await encryptBytes(data, key), key)).toEqual(data);
  });

  it('throws macMismatch when the ciphertext is tampered with', async () => {
    const enc = await encryptString('hello', key);
    const [type, rest] = enc.split('.') as [string, string];
    const [iv, ct, mac] = rest.split('|') as [string, string, string];
    const ctBytes = fromBase64(ct); ctBytes[0]! ^= 0x01;
    const tampered = `${type}.${iv}|${toBase64(ctBytes)}|${mac}`;
    try { await decryptString(tampered, key); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('macMismatch'); }
  });

  it('throws macMismatch when the MAC is tampered with', async () => {
    const enc = await encryptString('hello', key);
    const [type, rest] = enc.split('.') as [string, string];
    const [iv, ct, mac] = rest.split('|') as [string, string, string];
    const macBytes = fromBase64(mac); macBytes[0]! ^= 0x01;
    const tampered = `${type}.${iv}|${ct}|${toBase64(macBytes)}`;
    try { await decryptString(tampered, key); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('macMismatch'); }
  });

  it('throws when the wrong MAC key is used', async () => {
    const wrong = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(3) };
    await expect(decryptString(await encryptString('hello', key), wrong)).rejects.toBeInstanceOf(DecryptError);
  });

  it('never returns a plaintext-shaped string on MAC failure', async () => {
    const wrong = { encKey: new Uint8Array(32).fill(9), macKey: new Uint8Array(32).fill(9) };
    await expect(decryptString(await encryptString('secret', key), wrong)).rejects.toThrow();
  });

  // WebCrypto 对非法密钥长度抛的是 DOMException。统一成 DecryptError，
  // 否则同一个 API 会漏出两种错误类型，调用方没法只 catch 一种。
  it('throws DecryptError (not DOMException) for a wrong-size key', async () => {
    const valid = await encryptString('x', key);
    for (const [enc, mac] of [[31, 32], [32, 31], [16, 32], [0, 0]] as Array<[number, number]>) {
      const bad = { encKey: new Uint8Array(enc).fill(1), macKey: new Uint8Array(mac).fill(2) };
      await expect(decryptString(valid, bad), `encKey=${enc} macKey=${mac}`)
        .rejects.toBeInstanceOf(DecryptError);
    }
  });

  // Bitwarden 的字段大量是 null / 缺失，解密循环一定会遇到
  it('throws DecryptError (not TypeError) for null / undefined input', async () => {
    for (const bad of [null, undefined, 42, {}]) {
      await expect(decryptString(bad as unknown as string, key), `输入 ${JSON.stringify(bad)}`)
        .rejects.toBeInstanceOf(DecryptError);
    }
  });
});

describe('zeroizeKey', () => {
  it('overwrites both key buffers', () => {
    const k = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
    zeroizeKey(k);
    expect(k.encKey).toEqual(new Uint8Array(32));
    expect(k.macKey).toEqual(new Uint8Array(32));
  });
});
