import {
  concatBytes, deriveMasterKey, encryptBytes, hashMasterPassword, makeUserKey,
  stretchMasterKey, toBase64, zeroize, zeroizeKey, type SymmetricKey,
} from '@1warden/crypto';
import type { RegistrationKeys } from '@1warden/api';

export function validateRegistrationPassword(password: string, confirmation: string): void {
  if (password.length < 12) throw new Error('主密码至少需要 12 个字符');
  if (password !== confirmation) throw new Error('两次输入的主密码不一致');
}

/** Only encrypted key material leaves this function. Matches the existing login KDF. */
export async function createRegistrationKeys(email: string, password: string): Promise<RegistrationKeys> {
  const master = await deriveMasterKey(password, email, { kdf: 0, iterations: 600_000 });
  let stretched: SymmetricKey | undefined;
  let user: SymmetricKey | undefined;
  let privateDer: Uint8Array | undefined;
  let userBytes: Uint8Array | undefined;
  try {
    stretched = await stretchMasterKey(master);
    user = makeUserKey();
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
    privateDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    userBytes = concatBytes(user.encKey, user.macKey);
    return {
      masterPasswordHash: await hashMasterPassword(master, password),
      key: await encryptBytes(userBytes, stretched),
      keys: { publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
        encryptedPrivateKey: await encryptBytes(privateDer, user) },
      kdfType: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null,
    };
  } finally {
    zeroize(master);
    if (stretched) zeroizeKey(stretched);
    if (user) zeroizeKey(user);
    if (privateDer) zeroize(privateDer);
    if (userBytes) zeroize(userBytes);
  }
}
