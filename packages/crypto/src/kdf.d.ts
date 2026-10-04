export declare const KDF_TYPE_PBKDF2 = 0;
export declare const KDF_TYPE_ARGON2ID = 1;
export type KdfConfig = {
    kdf: typeof KDF_TYPE_PBKDF2;
    iterations: number;
} | {
    kdf: typeof KDF_TYPE_ARGON2ID;
    iterations: number;
    memory: number;
    parallelism: number;
};
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
export declare function deriveMasterKey(password: string, email: string, kdf: KdfConfig): Promise<Uint8Array>;
/**
 * masterPasswordHash = base64(PBKDF2-SHA256(password = masterKey, salt = masterPassword, 1 轮))
 *
 * ⚠️ 参数顺序是**反的**：主密钥当「密码」，主密码当「盐」。这是 Bitwarden 有意的设计。
 * 发送给服务端做认证；主密码本身永不离开设备。
 */
export declare function hashMasterPassword(masterKey: Uint8Array, password: string): Promise<string>;
