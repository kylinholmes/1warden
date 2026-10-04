/**
 * Bitwarden 的加密类型编号。
 * 注意：类型 1 官方已废弃（TS 枚举里已删除该值，服务端枚举也不含它），
 * 这里保留编号只为能正确报错，不做实现。
 */
export declare const EncryptionType: {
    readonly AesCbc256_B64: 0;
    readonly AesCbc128_HmacSha256_B64: 1;
    readonly AesCbc256_HmacSha256_B64: 2;
    readonly Rsa2048_OaepSha256_B64: 3;
    readonly Rsa2048_OaepSha1_B64: 4;
    readonly Rsa2048_OaepSha256_HmacSha256_B64: 5;
    readonly Rsa2048_OaepSha1_HmacSha256_B64: 6;
};
export type EncString = string;
export declare class DecryptError extends Error {
    readonly kind: 'malformed' | 'macMismatch' | 'unsupportedType';
    constructor(kind: 'malformed' | 'macMismatch' | 'unsupportedType', message: string);
}
export interface ParsedEncString {
    type: number;
    iv: Uint8Array | undefined;
    data: Uint8Array;
    mac: Uint8Array | undefined;
}
export declare function parseEncString(s: EncString): ParsedEncString;
export declare function serializeEncString(type: number, iv: Uint8Array | undefined, data: Uint8Array, mac?: Uint8Array): EncString;
export declare function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
export declare function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
export declare function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
