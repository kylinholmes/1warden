import { describe, expect, it } from 'vitest';
import { buildProfileItem, isProfileItem, parseProfile, selectProfileItem, profileRevision } from './profile';

const profile = { displayName: '小林', avatarDataUrl: null };
describe('encrypted Profile record codec', () => {
  it('requires a secure-note marker, not its display name', () => {
    const item = buildProfileItem(profile);
    expect(isProfileItem(item)).toBe(true);
    expect(isProfileItem({ ...item, customFields: [] })).toBe(false);
    expect(isProfileItem({ ...item, type: 'login' })).toBe(false);
    expect(parseProfile(item)).toEqual(profile);
  });
  it('preserves unknown personalization and existing record metadata', () => {
    const old = { ...buildProfileItem(profile), id: 'a', wrappedKey: 'wrapped', updatedAt: '2026-01-01' };
    old.notes = JSON.stringify({ ...JSON.parse(old.notes!), futurePreference: { color: 'blue' } });
    const next = buildProfileItem({ ...profile, displayName: 'New' }, old);
    expect(JSON.parse(next.notes!).futurePreference).toEqual({ color: 'blue' });
    expect(next.wrappedKey).toBe('wrapped');
    expect(next.id).toBe('a');
    expect(profileRevision(next)).toBe(profileRevision(old));
  });
  it('rejects damaged and future notes rather than overwriting them', () => {
    const item = buildProfileItem(profile);
    for (const notes of ['{', JSON.stringify({ schema: '1warden.profile', version: 2 })]) {
      expect(() => buildProfileItem(profile, { ...item, notes })).toThrow();
    }
    expect(() => parseProfile({ ...item, notesFailed: true })).toThrow();
  });
  it('validates names, avatar MIME and total byte budget', () => {
    expect(() => buildProfileItem({ ...profile, displayName: 'x'.repeat(81) })).toThrow();
    expect(() => buildProfileItem({ ...profile, avatarDataUrl: 'https://example.com/pixel' })).toThrow();
    expect(() => buildProfileItem({ ...profile, avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow();
    expect(() => buildProfileItem({ ...profile, avatarDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(5600) })).toThrow();
    const old = buildProfileItem(profile);
    old.notes = JSON.stringify({ ...JSON.parse(old.notes!), large: '中'.repeat(2400) });
    expect(() => buildProfileItem(profile, old)).toThrow(/过大/);
  });
  it('selects latest active marker deterministically without mutating records', () => {
    const a = { ...buildProfileItem(profile), id: 'a', updatedAt: '2026-01-01' };
    const b = { ...a, id: 'b' };
    const removed = { ...a, id: 'z', updatedAt: '2027-01-01', deletedAt: 'now' };
    expect(selectProfileItem([removed, a, b])?.id).toBe('b');
    expect(selectProfileItem([b, a, removed])?.id).toBe('b');
  });
});
