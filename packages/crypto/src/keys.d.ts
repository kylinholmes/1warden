export interface SymmetricKey {
    encKey: Uint8Array;
    macKey: Uint8Array;
}
export declare function stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey>;
export declare function makeUserKey(): SymmetricKey;
export declare function zeroizeKey(key: SymmetricKey): void;
/** 用 type-2（AesCbc256_HmacSha256_B64）加密任意字节：encrypt-then-MAC */
export declare function encryptBytes(data: Uint8Array, key: SymmetricKey): Promise<string>;
export declare function decryptBytes(enc: string, key: SymmetricKey): Promise<Uint8Array>;
export declare function encryptString(plain: string, key: SymmetricKey): Promise<string>;
export declare function decryptString(enc: string, key: SymmetricKey): Promise<string>;
