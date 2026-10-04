import { DecryptError, parseEncString, serializeEncString, EncryptionType } from './encstring';
const RSA_TYPES = new Set([
    EncryptionType.Rsa2048_OaepSha256_B64,
    EncryptionType.Rsa2048_OaepSha1_B64,
    EncryptionType.Rsa2048_OaepSha256_HmacSha256_B64,
    EncryptionType.Rsa2048_OaepSha1_HmacSha256_B64,
]);
async function importPrivateKey(der, hash) {
    try {
        return await globalThis.crypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash }, false, ['decrypt']);
    }
    catch {
        throw new DecryptError('malformed', '私钥导入失败：不是合法的 PKCS#8 DER');
    }
}
async function importPublicKey(der, hash) {
    try {
        return await globalThis.crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash }, false, ['encrypt']);
    }
    catch {
        throw new DecryptError('malformed', '公钥导入失败：不是合法的 SPKI DER');
    }
}
/**
 * 用 RSA 私钥解密。私钥是 **PKCS#8 DER**（Bitwarden 用的是 PKCS#8，不是 PKCS#1）。
 * 类型 3/5 = OAEP-SHA256，类型 4/6 = OAEP-SHA1（老客户端默认）。
 */
export async function decryptWithPrivateKey(enc, privateKeyDer) {
    const parsed = parseEncString(enc);
    if (!RSA_TYPES.has(parsed.type)) {
        throw new DecryptError('unsupportedType', `不是 RSA 类型: ${parsed.type}`);
    }
    const hash = parsed.type === EncryptionType.Rsa2048_OaepSha1_B64
        || parsed.type === EncryptionType.Rsa2048_OaepSha1_HmacSha256_B64
        ? 'SHA-1' : 'SHA-256';
    const key = await importPrivateKey(privateKeyDer, hash);
    try {
        return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, parsed.data));
    }
    catch {
        throw new DecryptError('malformed', 'RSA 解密失败（密钥不匹配或数据损坏）');
    }
}
/** 用类型 4（OAEP-SHA1）加密 —— 老客户端默认期望的格式 */
export async function encryptWithPublicKey(data, publicKeyDer) {
    const key = await importPublicKey(publicKeyDer, 'SHA-1');
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, data));
    return serializeEncString(EncryptionType.Rsa2048_OaepSha1_B64, undefined, ct);
}
//# sourceMappingURL=rsa.js.map