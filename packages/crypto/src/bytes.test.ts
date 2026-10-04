import { describe, it, expect } from 'vitest';
import {
  toBase64, fromBase64, toBase64Url, fromBase64Url,
  utf8Encode, utf8Decode, constantTimeEqual, concatBytes, zeroize, sha256,
} from './bytes';

describe('base64', () => {
  it('round-trips ASCII', () => {
    expect(fromBase64(toBase64(utf8Encode('hello')))).toEqual(utf8Encode('hello'));
  });

  it('uses standard alphabet with padding', () => {
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('round-trips a 70KB buffer without stack overflow', () => {
    const big = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });

  it('uses url-safe alphabet without padding', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(fromBase64Url('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
  });
});

describe('utf8', () => {
  it('round-trips Chinese text', () => {
    const s = '我的密码🔐';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});

describe('constantTimeEqual', () => {
  it('is true for equal buffers', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it('is false for different buffers', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  it('is false for different lengths', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('concatBytes', () => {
  it('concatenates in order', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])))
      .toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('sha256', () => {
  it('matches the NIST vector for "abc"', async () => {
    expect(toBase64(await sha256(utf8Encode('abc'))))
      .toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('produces 32 bytes', async () => {
    expect(await sha256(new Uint8Array(0))).toHaveLength(32);
  });
});

describe('zeroize', () => {
  it('overwrites every byte with zero', () => {
    const b = new Uint8Array([1, 2, 3]);
    zeroize(b);
    expect(b).toEqual(new Uint8Array([0, 0, 0]));
  });
});
