import { argon2id, createSHA256, pbkdf2 } from 'hash-wasm';
import { sha256, utf8Encode } from './bytes';
import type { KdfConfig } from './kdf';

/** Export salts are case-sensitive strings, never normalized as email addresses. */
export async function derivePasswordKey(password: string, salt: string, kdf: KdfConfig): Promise<Uint8Array> {
  if (kdf.kdf === 0) {
    return pbkdf2({ password: utf8Encode(password), salt: utf8Encode(salt), iterations: kdf.iterations,
      hashLength: 32, hashFunction: createSHA256(), outputType: 'binary' });
  }
  return argon2id({ password: utf8Encode(password), salt: await sha256(utf8Encode(salt)),
    parallelism: kdf.parallelism, iterations: kdf.iterations, memorySize: kdf.memory * 1024,
    hashLength: 32, outputType: 'binary' });
}
