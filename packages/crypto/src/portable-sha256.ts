import { sha256 as wasmSha256 } from 'hash-wasm';

/** Content scripts on HTTP pages may have getRandomValues but no SubtleCrypto. */
export async function sha256Portable(data: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto.subtle) return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
  const hex = await wasmSha256(data);
  return Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));
}
