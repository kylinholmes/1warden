import {
  concatBytes, constantTimeEqual, randomBytes, utf8Encode, utf8Decode, zeroize,
} from './bytes';
import {
  EncryptionType, DecryptError, parseEncString, serializeEncString,
  aesCbcEncrypt, aesCbcDecrypt, hmacSha256,
} from './encstring';

export interface SymmetricKey {
  encKey: Uint8Array;
  macKey: Uint8Array;
}

/**
 * HKDF-Expand-SHA256，**只做 Expand 不做 Extract**
 * （masterKey 直接作为 PRK —— 这正是 Bitwarden 的语义，
 *   而 WebCrypto 的 `deriveBits({name:'HKDF'})` 会先做 Extract，
 *   即使用空盐也会先算一次 HMAC，得到的是**完全不同**的密钥）。
 *
 * 输出 32 字节只需一轮：T(1) = HMAC-SHA256(PRK, info || 0x01)
 * 正确性由 keys.test.ts 里的官方测试向量保证。
 */
async function hkdfExpand(prk: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const infoBytes = utf8Encode(info);
  // 显式标注为 Uint8Array（= Uint8Array<ArrayBufferLike>）：不标的话会被推断成
  // 窄类型 Uint8Array<ArrayBuffer>，而 WebCrypto 返回的是宽类型，赋值会报错。
  let okm: Uint8Array = new Uint8Array(0);
  let prev: Uint8Array = new Uint8Array(0);
  for (let counter = 1; okm.length < length; counter++) {
    prev = await hmacSha256(prk, concatBytes(prev, infoBytes, new Uint8Array([counter])));
    okm = concatBytes(okm, prev);
  }
  return okm.slice(0, length);
}

export async function stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey> {
  // 顺序 await 而非 Promise.all：每边只是一次 HMAC，开销可忽略，
  // 而 Promise.all 的元组推断会和 TS 5.9 的 Uint8Array<ArrayBuffer> 泛型打架。
  const encKey = await hkdfExpand(masterKey, 'enc', 32);
  const macKey = await hkdfExpand(masterKey, 'mac', 32);
  return { encKey, macKey };
}

export function makeUserKey(): SymmetricKey {
  return { encKey: randomBytes(32), macKey: randomBytes(32) };
}

export function zeroizeKey(key: SymmetricKey): void {
  zeroize(key.encKey);
  zeroize(key.macKey);
}

/** 用 type-2（AesCbc256_HmacSha256_B64）加密任意字节：encrypt-then-MAC */
export async function encryptBytes(data: Uint8Array, key: SymmetricKey): Promise<string> {
  const iv = randomBytes(16);
  const ct = await aesCbcEncrypt(key.encKey, iv, data);
  const mac = await hmacSha256(key.macKey, concatBytes(iv, ct));
  return serializeEncString(EncryptionType.AesCbc256_HmacSha256_B64, iv, ct, mac);
}

export async function decryptBytes(enc: string, key: SymmetricKey): Promise<Uint8Array> {
  const parsed = parseEncString(enc);
  if (parsed.type !== EncryptionType.AesCbc256_HmacSha256_B64) {
    throw new DecryptError('unsupportedType', `对称解密只支持类型 2，收到类型 ${parsed.type}`);
  }
  const { iv, data, mac } = parsed as { iv: Uint8Array; data: Uint8Array; mac: Uint8Array };

  // 先验 MAC，再解密（encrypt-then-MAC，失败即关闭）
  const expected = await hmacSha256(key.macKey, concatBytes(iv, data));
  if (!constantTimeEqual(expected, mac)) {
    throw new DecryptError('macMismatch', 'MAC 校验失败：数据可能被篡改，或密钥不匹配');
  }
  return aesCbcDecrypt(key.encKey, iv, data);
}

export async function encryptString(plain: string, key: SymmetricKey): Promise<string> {
  return encryptBytes(utf8Encode(plain), key);
}

export async function decryptString(enc: string, key: SymmetricKey): Promise<string> {
  return utf8Decode(await decryptBytes(enc, key));
}
