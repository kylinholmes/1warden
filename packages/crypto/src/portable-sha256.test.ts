import { expect, it } from 'vitest';
import { sha256Portable } from './portable-sha256';

it('matches the NIST SHA256 vector without subtle on HTTP content documents', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
  try {
    const bytes = await sha256Portable(new TextEncoder().encode('abc'));
    expect(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'subtle', original); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
  }
});
