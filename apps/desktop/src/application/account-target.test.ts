import { describe, expect, it } from 'vitest';
import { lockedAccount } from './account-target';
describe('selected account identity', () => {
  it('distinguishes same-server accounts and same-email servers', () => {
    const a = lockedAccount({ serverUrl: 'HTTPS://ONE.EXAMPLE/', email: ' A@Example.com ' });
    expect(a.serverUrl).toBe('https://one.example'); expect(a.email).toBe('a@example.com'); expect(a.userId).toBe('');
    expect(lockedAccount({ serverUrl: a.serverUrl, email: 'b@example.com' })).not.toEqual(a);
    expect(lockedAccount({ serverUrl: 'https://two.example', email: a.email })).not.toEqual(a);
  });
  it('rejects malformed identities before retiring the active account', () => {
    for (const serverUrl of ['javascript:alert(1)', 'file:///tmp/foo', 'https://user:password@example.com', 'garbage']) {
      expect(() => lockedAccount({ serverUrl, email: 'a@b.com' })).toThrow();
    }
  });
});
