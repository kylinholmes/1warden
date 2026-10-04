/**
 * ⚠️ Bitwarden 的 base32 解码器**刻意不是标准实现** —— 见 `bitwarden-vault/src/totp.rs`
 * 中 `decode_b32` 的注释原文：「not technically a correct base32 decoder since we
 * filter out various characters, and use exact chunking」。它的实际行为是：
 *   1. 整个字符串转大写
 *   2. **字母表外的字符被静默丢弃**（而不是报错）—— `=`、`-`、空格、`0/1/8/9` 都会被丢掉
 *   3. 每个保留字符出 5 bit
 *   4. 末尾不足 8 位的残余 bit **被丢弃**
 *
 * 结果：`"PIUD1IS!EQYA="` 与 `"PIUDISEQYA"` 必须解出完全相同的值。
 * 如果照抄标准 base32（遇到非法字符就抛错），一部分用户的验证码会直接算不出来。
 */
export declare function base32Decode(input: string): Uint8Array;
export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';
export interface TotpOptions {
    digits?: number;
    period?: number;
    algorithm?: TotpAlgorithm;
}
export interface TotpResult {
    code: string;
    period: number;
    remaining: number;
}
/**
 * 生成 TOTP 验证码。`secretOrUri` 支持官方实现的三种输入形态：
 *   - `steam://<base32>`            → Steam Guard（5 位、自定义字母表、强制 SHA-1）
 *   - `otpauth://totp/...?secret=`  → 按 URI 里的参数
 *   - 裸 base32                     → 按 `opts`（默认 6 位 / 30 秒 / SHA-1）
 */
export declare function generateTotp(secretOrUri: string, at?: number, opts?: TotpOptions): Promise<TotpResult>;
export interface ParsedOtpauth {
    secret: string;
    digits: number;
    period: number;
    algorithm: TotpAlgorithm;
    issuer: string | undefined;
    account: string | undefined;
    isSteam: boolean;
}
export declare function parseOtpauthUri(input: string): ParsedOtpauth;
