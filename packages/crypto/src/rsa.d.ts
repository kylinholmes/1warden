/**
 * 用 RSA 私钥解密。私钥是 **PKCS#8 DER**（Bitwarden 用的是 PKCS#8，不是 PKCS#1）。
 * 类型 3/5 = OAEP-SHA256，类型 4/6 = OAEP-SHA1（老客户端默认）。
 */
export declare function decryptWithPrivateKey(enc: string, privateKeyDer: Uint8Array): Promise<Uint8Array>;
/** 用类型 4（OAEP-SHA1）加密 —— 老客户端默认期望的格式 */
export declare function encryptWithPublicKey(data: Uint8Array, publicKeyDer: Uint8Array): Promise<string>;
