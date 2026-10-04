const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeWith(alphabet: string, bytes: Uint8Array, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2]!;
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) { if (pad) out += '=='; break; }
    out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) { if (pad) out += '='; break; }
    out += alphabet[b2 & 0x3f]!;
  }
  return out;
}

function decodeWith(alphabet: string, s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0, bits = 0, o = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v === -1) throw new Error(`Invalid base64 character: ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 0xff; }
  }
  return out;
}

export const toBase64 = (b: Uint8Array): string => encodeWith(B64, b, true);
export const fromBase64 = (s: string): Uint8Array => decodeWith(B64, s);
export const toBase64Url = (b: Uint8Array): string => encodeWith(B64URL, b, false);
export const fromBase64Url = (s: string): Uint8Array => decodeWith(B64URL, s);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const utf8Encode = (s: string): Uint8Array => encoder.encode(s);
export const utf8Decode = (b: Uint8Array): string => decoder.decode(b);

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function zeroize(b: Uint8Array): void {
  b.fill(0);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
