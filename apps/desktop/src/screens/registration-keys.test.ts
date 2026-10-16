import { describe, expect, it } from 'vitest';
import { decryptBytes, decryptWithPrivateKey, deriveMasterKey, encryptWithPublicKey, fromBase64,
  hashMasterPassword, stretchMasterKey, zeroize, zeroizeKey } from '@1warden/crypto';
import { createRegistrationKeys, validateRegistrationPassword } from './registration-keys';

describe('registration keys interoperate with the existing vault', () => {
  // Real 600k-round KDFs and RSA generation compete with other tests on CI.
  it('wraps a fresh 64-byte user key, encrypts PKCS#8 RSA, and only returns encrypted credentials', async () => {
    const password = 'a long disposable test passphrase';
    const email = 'person@example.test';
    const payload = await createRegistrationKeys(email, password);
    expect(payload).toMatchObject({ kdfType: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null });
    expect(JSON.stringify(payload)).not.toContain(password);
    const master = await deriveMasterKey(password, email, { kdf: 0, iterations: payload.kdfIterations });
    const stretched = await stretchMasterKey(master);
    const bytes = await decryptBytes(payload.key, stretched);
    expect(bytes.length).toBe(64);
    const userKey = { encKey: bytes.slice(0, 32), macKey: bytes.slice(32) };
    const privateKey = await decryptBytes(payload.keys.encryptedPrivateKey, userKey);
    const fixture = new Uint8Array([1, 2, 3]);
    const encrypted = await encryptWithPublicKey(fixture, fromBase64(payload.keys.publicKey));
    expect(await decryptWithPrivateKey(encrypted, privateKey)).toEqual(fixture);
    expect(payload.masterPasswordHash).toBe(await hashMasterPassword(master, password));
    zeroize(privateKey); zeroize(master); zeroize(bytes); zeroizeKey(stretched); zeroizeKey(userKey);
  }, 30_000);
  it('requires the official minimum length and a matching confirmation', () => {
    expect(() => validateRegistrationPassword('short', 'short')).toThrow('12');
    expect(() => validateRegistrationPassword('a long password', 'another password')).toThrow('不一致');
    expect(() => validateRegistrationPassword('a long password', 'a long password')).not.toThrow();
  });
});
