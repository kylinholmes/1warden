import { fromBase64, toBase64 } from './bytes';

/**
 * Bitwarden 的加密类型编号。
 * 注意：类型 1 官方已废弃（TS 枚举里已删除该值，服务端枚举也不含它），
 * 这里保留编号只为能正确报错，不做实现。
 */
export const EncryptionType = {
  AesCbc256_B64: 0,
  AesCbc128_HmacSha256_B64: 1,
  AesCbc256_HmacSha256_B64: 2,
  Rsa2048_OaepSha256_B64: 3,
  Rsa2048_OaepSha1_B64: 4,
  Rsa2048_OaepSha256_HmacSha256_B64: 5,
  Rsa2048_OaepSha1_HmacSha256_B64: 6,
} as const;

export type EncString = string;

export class DecryptError extends Error {
  constructor(readonly kind: 'malformed' | 'macMismatch' | 'unsupportedType', message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

export interface ParsedEncString {
  type: number;
  iv: Uint8Array | undefined;
  data: Uint8Array;
  mac: Uint8Array | undefined;
}

/** 各类型的固定分段长度。用于严格校验，畸形输入绝不静默通过。 */
const SHAPE: Record<number, { iv: number; mac: number }> = {
  0: { iv: 16, mac: 0 },
  1: { iv: 16, mac: 32 },
  2: { iv: 16, mac: 32 },
  3: { iv: 0, mac: 0 },
  4: { iv: 0, mac: 0 },
  5: { iv: 0, mac: 32 },
  6: { iv: 0, mac: 32 },
};

export function parseEncString(s: EncString): ParsedEncString {
  // ⚠️ Bitwarden 的字段大量是 null / 缺失（没填的用户名、空的 notes）。
  // 这里必须抛 DecryptError 而不是把 TypeError 漏出去 —— 否则调用方无法按类型分流，
  // 一个空字段就能中断整条条目、甚至整个保险库的解密。
  if (typeof s !== 'string' || s.length === 0) {
    throw new DecryptError(
      'malformed',
      `EncString 必须是非空字符串，收到 ${s === null ? 'null' : typeof s}`,
    );
  }

  const dot = s.indexOf('.');
  if (dot <= 0) throw new DecryptError('malformed', 'EncString 缺少类型前缀');

  const type = Number(s.slice(0, dot));
  if (!Number.isInteger(type) || !(type in SHAPE)) {
    throw new DecryptError('unsupportedType', `未知的加密类型: ${s.slice(0, dot)}`);
  }
  const shape = SHAPE[type]!;
  const body = s.slice(dot + 1);
  // 段数 = (有 IV ? 1 : 0) + 1(数据段) + (有 MAC ? 1 : 0)
  // 注意 type 0 是 iv|data 两段（无 MAC），不是三段
  const expectedSegments = (shape.iv > 0 ? 1 : 0) + 1 + (shape.mac > 0 ? 1 : 0);
  const segments = body.split('|');
  if (segments.length !== expectedSegments) {
    throw new DecryptError('malformed', `类型 ${type} 期望 ${expectedSegments} 段，实际 ${segments.length} 段`);
  }

  let iv: Uint8Array | undefined;
  let data: Uint8Array;
  let mac: Uint8Array | undefined;

  const decode = (part: string, what: string): Uint8Array => {
    try { return fromBase64(part); }
    catch { throw new DecryptError('malformed', `${what} 不是合法 base64`); }
  };

  if (shape.iv > 0) {
    iv = decode(segments[0]!, 'IV');
    if (iv.length !== shape.iv) throw new DecryptError('malformed', `IV 长度应为 ${shape.iv}，实际 ${iv.length}`);
    data = decode(segments[1]!, '密文');
    if (shape.mac > 0) {
      mac = decode(segments[2]!, 'MAC');
      if (mac.length !== shape.mac) throw new DecryptError('malformed', `MAC 长度应为 ${shape.mac}，实际 ${mac.length}`);
    }
  } else {
    data = decode(segments[0]!, '密文');
    if (shape.mac > 0) {
      mac = decode(segments[1]!, 'MAC');
      if (mac.length !== shape.mac) throw new DecryptError('malformed', `MAC 长度应为 ${shape.mac}，实际 ${mac.length}`);
    }
  }

  if (data.length === 0) throw new DecryptError('malformed', '密文数据为空');
  return { type, iv, data, mac };
}

export function serializeEncString(
  type: number, iv: Uint8Array | undefined, data: Uint8Array, mac?: Uint8Array,
): EncString {
  const parts = [iv ? toBase64(iv) : undefined, toBase64(data), mac ? toBase64(mac) : undefined]
    .filter((p): p is string => p !== undefined);
  return `${type}.${parts.join('|')}`;
}

// ── 底层算法 ──

const AES_KEY_SIZES = new Set([16, 24, 32]);

async function importAesKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  // 长度不合法时 WebCrypto 抛的是 DOMException。密钥损坏/传错属于调用方能处理的
  // 失败，统一成 DecryptError，别让两种错误类型从同一个 API 漏出去。
  if (!AES_KEY_SIZES.has(raw.length)) {
    throw new DecryptError('malformed', `AES 密钥长度必须是 16/24/32 字节，收到 ${raw.length}`);
  }
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-CBC' }, false, [usage]);
}

async function importHmacKey(raw: Uint8Array, hash: 'SHA-256' | 'SHA-1' | 'SHA-512' = 'SHA-256'): Promise<CryptoKey> {
  if (raw.length === 0) throw new DecryptError('malformed', 'HMAC 密钥不能为空');
  return globalThis.crypto.subtle.importKey(
    'raw', raw as BufferSource, { name: 'HMAC', hash }, false, ['sign'],
  );
}

export async function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(key, 'encrypt');
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: iv as BufferSource }, k, plaintext as BufferSource,
  );
  return new Uint8Array(ct);
}

export async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new DecryptError('malformed', `密文长度 ${ciphertext.length} 不是 16 的倍数`);
  }
  const k = await importAesKey(key, 'decrypt');
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv as BufferSource }, k, ciphertext as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError('malformed', 'AES-CBC 解密失败（填充错误）');
  }
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await importHmacKey(key);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, data as BufferSource));
}
