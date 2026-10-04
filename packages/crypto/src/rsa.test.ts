import { describe, it, expect } from 'vitest';
import { decryptWithPrivateKey, encryptWithPublicKey } from './rsa';
import { DecryptError } from './encstring';
import { utf8Decode, utf8Encode } from './bytes';

async function makeKeyPair() {
  const kp = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1',
    },
    true, ['encrypt', 'decrypt'],
  ) as CryptoKeyPair;
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { priv, pub };
}

describe('RSA-OAEP', () => {
  it('round-trips data encrypted with the public key (type 4, SHA-1)', async () => {
    const { priv, pub } = await makeKeyPair();
    const enc = await encryptWithPublicKey(utf8Encode('user-key-material'), pub);
    expect(enc.startsWith('4.')).toBe(true);
    expect(utf8Decode(await decryptWithPrivateKey(enc, priv))).toBe('user-key-material');
  }, 30_000);

  it('throws DecryptError on a malformed RSA EncString', async () => {
    const { priv } = await makeKeyPair();
    await expect(decryptWithPrivateKey('4.!!!not-base64!!!', priv)).rejects.toBeInstanceOf(DecryptError);
  }, 30_000);

  it('throws DecryptError when the wrong private key is used', async () => {
    const a = await makeKeyPair(), b = await makeKeyPair();
    const enc = await encryptWithPublicKey(utf8Encode('secret'), a.pub);
    await expect(decryptWithPrivateKey(enc, b.priv)).rejects.toBeInstanceOf(DecryptError);
  }, 60_000);

  it('throws DecryptError on a bogus private key', async () => {
    const { pub } = await makeKeyPair();
    const enc = await encryptWithPublicKey(utf8Encode('secret'), pub);
    await expect(decryptWithPrivateKey(enc, new Uint8Array(64))).rejects.toBeInstanceOf(DecryptError);
  }, 30_000);

  it('rejects a non-RSA EncString type', async () => {
    const { priv } = await makeKeyPair();
    await expect(decryptWithPrivateKey('2.a|b|c', priv)).rejects.toBeInstanceOf(DecryptError);
  }, 30_000);
});
