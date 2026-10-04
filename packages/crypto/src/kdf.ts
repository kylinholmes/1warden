import { argon2id, pbkdf2, createSHA256 } from 'hash-wasm';
import { toBase64, utf8Encode, sha256 } from './bytes';

export const KDF_TYPE_PBKDF2 = 0;
export const KDF_TYPE_ARGON2ID = 1;

export type KdfConfig =
  | { kdf: typeof KDF_TYPE_PBKDF2; iterations: number }
  | { kdf: typeof KDF_TYPE_ARGON2ID; iterations: number; memory: number; parallelism: number };

/**
 * Bitwarden 服务端返回的 KdfMemory 单位（**MiB**）→ hash-wasm 期望的 **KiB**。
 * 已由 bitwarden/sdk-internal 源码确认：`let memory = memory.get() * 1024; // Convert MiB to KiB`
 */
const ARGON2_MEMORY_UNIT_MULTIPLIER = 1024;

/**
 * masterKey = KDF(password, salt)
 *
 * ⚠️ **两种 KDF 的盐不同，这是最容易踩且最难排查的坑：**
 *   - PBKDF2   → 盐 = `lowercase(trim(email))` 原文
 *   - Argon2id → 盐 = **`SHA-256(lowercase(trim(email)))`**，即先把邮箱哈希一次
 *
 * 官方实现（`bitwarden-crypto/src/keys/kdf.rs`）对 Argon2 分支显式做了
 * `Sha256::new().chain_update(salt).finalize()`。搞错的话：PBKDF2 账户一切正常，
 * Argon2id 账户永远提示「密码错误」，且没有任何线索指向盐。
 */
export async function deriveMasterKey(
  password: string,
  email: string,
  kdf: KdfConfig,
): Promise<Uint8Array> {
  const emailSalt = utf8Encode(email.trim().toLowerCase());
  const pw = utf8Encode(password);

  switch (kdf.kdf) {
    case KDF_TYPE_PBKDF2:
      return pbkdf2({
        password: pw, salt: emailSalt, iterations: kdf.iterations, hashLength: 32,
        hashFunction: createSHA256(), // hash-wasm 要的是 hasher 实例，不是 'sha256' 字符串
        outputType: 'binary',         // 默认是 'hex'，会返回 64 个十六进制字符而不是字节
      });

    case KDF_TYPE_ARGON2ID:
      return argon2id({
        password: pw,
        salt: await sha256(emailSalt), // ← 注意：盐先被 SHA-256 了一次
        parallelism: kdf.parallelism,
        iterations: kdf.iterations,
        memorySize: kdf.memory * ARGON2_MEMORY_UNIT_MULTIPLIER,
        hashLength: 32,
        outputType: 'binary',
      });

    default:
      throw new Error(`Unsupported KDF type: ${(kdf as { kdf: number }).kdf}`);
  }
}

/**
 * masterPasswordHash = base64(PBKDF2-SHA256(password = masterKey, salt = masterPassword, 1 轮))
 *
 * ⚠️ 参数顺序是**反的**：主密钥当「密码」，主密码当「盐」。这是 Bitwarden 有意的设计。
 * 发送给服务端做认证；主密码本身永不离开设备。
 */
export async function hashMasterPassword(masterKey: Uint8Array, password: string): Promise<string> {
  const hash = await pbkdf2({
    password: masterKey,
    salt: utf8Encode(password),
    iterations: 1,
    hashLength: 32,
    hashFunction: createSHA256(),
    outputType: 'binary',
  });
  return toBase64(hash);
}
