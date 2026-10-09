import { describe, expect, it } from 'vitest';
import { buildProfileItem, parseProfile } from './profile';
import { buildPreferencesItem, buildDeviceItem, parseProfileSettings, validatePreferences, validateDevice, MAX_PROFILE_DEVICES } from './profile-settings';

const prefs = { mode: 'system' as const, palette: 'graphite', showTypes: false };
const device = { id: 'install-1', name: 'Windows · Edge', platform: 'windows' as const, client: 'extension' as const };
const profile = { displayName: 'Lin', avatarDataUrl: null };
describe('encrypted account preferences and device history', () => {
  it('syncs icon style and preserves the selection when legacy clients omit it', () => {
    const original = buildPreferencesItem({ ...prefs, iconStyle: 'plate' });
    expect(parseProfileSettings(original).preferences?.iconStyle).toBe('plate');
    const legacyEdit = buildPreferencesItem({ ...prefs, palette: 'dracula' }, original);
    expect(parseProfileSettings(legacyEdit).preferences?.iconStyle).toBe('plate');
    expect(parseProfileSettings(buildPreferencesItem({ ...prefs, iconStyle: 'original' }, legacyEdit)).preferences?.iconStyle).toBe('original');
  });
  it('defaults missing or future icon styles for display while preserving a future stored value', () => {
    expect(validatePreferences(prefs).iconStyle ?? 'original').toBe('original');
    const old = buildPreferencesItem(prefs);
    const doc = JSON.parse(old.notes!);
    doc.settings.preferences.iconStyle = 'future-style'; old.notes = JSON.stringify(doc);
    expect(parseProfileSettings(old).preferences?.iconStyle ?? 'original').toBe('original');
    const edited = buildPreferencesItem({ ...prefs, palette: 'ayu', iconStyle: 'original' }, old);
    expect(JSON.parse(edited.notes!).settings.preferences.iconStyle).toBe('future-style');
  });
  it('reads legacy profiles and preserves profile and unknown fields on settings edits', () => {
    const old = buildProfileItem(profile);
    old.notes = JSON.stringify({ ...JSON.parse(old.notes!), future: { keep: true } });
    expect(parseProfileSettings(old)).toEqual({ preferences: null, devices: [] });
    const next = buildPreferencesItem(prefs, old);
    expect(parseProfileSettings(next).preferences).toEqual(prefs);
    expect(parseProfile(next)).toEqual(profile);
    expect(JSON.parse(next.notes!).future).toEqual({ keep: true });
    expect(parseProfileSettings(buildProfileItem({ ...profile, displayName: 'New' }, next)).preferences).toEqual(prefs);
  });
  it('validates supported fields without exposing arbitrary settings', () => {
    expect(validatePreferences({ ...prefs, secret: 'not-a-setting' })).toEqual(prefs);
    for (const patch of [{ mode: 'bad' }, { mode: ['dark'] }, { palette: '<script>' }, { showTypes: 'yes' }]) {
      expect(() => validatePreferences({ ...prefs, ...patch })).toThrow();
    }
    expect(() => validateDevice({ ...device, platform: ['windows'] })).toThrow();
    expect(() => validateDevice({ ...device, client: ['extension'] })).toThrow();
  });
  it('updates a device in place, preserves first use, and skips frequent writes', () => {
    const old = buildDeviceItem(device, 1000)!;
    expect(buildDeviceItem(device, 2000, old)).toBeUndefined();
    const next = buildDeviceItem(device, 3_601_000, old)!;
    expect(parseProfileSettings(next).devices).toEqual([{ ...device, firstSeen: 1000, lastSeen: 3_601_000 }]);
  });
  it('bounds history and the encrypted note size, without dropping unrelated data', () => {
    let old = buildProfileItem({ ...profile, avatarDataUrl: 'data:image/jpeg;base64,' + 'AAAA'.repeat(1390) });
    for (let i = 0; i < 30; i++) old = buildDeviceItem({ ...device, id: `install-${i}`, name: '设备'.repeat(12) }, 1000 + i, old)!;
    const data = parseProfileSettings(old);
    expect(data.devices.length).toBeGreaterThan(0);
    expect(data.devices.length).toBeLessThanOrEqual(MAX_PROFILE_DEVICES);
    expect(data.devices[0]!.id).toBe('install-29');
    expect(new TextEncoder().encode(old.notes!).length).toBeLessThanOrEqual(7000);
    expect(parseProfile(old).avatarDataUrl).toHaveLength(5583);
  });
  it('refuses damaged/future sections instead of overwriting them', () => {
    const old = buildProfileItem(profile);
    for (const settings of [{ version: 2 }, { version: 1, preferences: prefs, devices: 'bad' }]) {
      old.notes = JSON.stringify({ schema: '1warden.profile', version: 1, ...profile, settings });
      expect(() => buildDeviceItem(device, 1000, old)).toThrow();
      expect(() => buildPreferencesItem(prefs, old)).toThrow();
    }
  });
});
