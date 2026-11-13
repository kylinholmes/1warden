import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getClipboardClearMs, setClipboardClearMs } from '@1warden/ui/clipboard';
import { getSecurityPreferences, initializeSecurityPreferences, readSecurityPreferences, SECURITY_PREFERENCES_KEY,
  securityPreferencesStore, setSecurityPreference } from './security-preferences';

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); } });
  initializeSecurityPreferences();
});
afterEach(() => { securityPreferencesStore.setState({ autoLockMinutes: 15, clipboardClearSeconds: 30 }); setClipboardClearMs(30_000); vi.unstubAllGlobals(); });

it('persists only bounded local settings and restores their runtime behavior', () => {
  setSecurityPreference('autoLockMinutes', 5);
  setSecurityPreference('clipboardClearSeconds', 10);
  expect(JSON.parse(storage.get(SECURITY_PREFERENCES_KEY)!)).toEqual({ autoLockMinutes: 5, clipboardClearSeconds: 10 });
  expect(getClipboardClearMs()).toBe(10_000);
  securityPreferencesStore.setState({ autoLockMinutes: 15, clipboardClearSeconds: 30 });
  setClipboardClearMs(30_000);
  initializeSecurityPreferences();
  expect(getSecurityPreferences()).toEqual({ autoLockMinutes: 5, clipboardClearSeconds: 10 });
  expect(getClipboardClearMs()).toBe(10_000);
});

it.each(['broken', 'null', '{"autoLockMinutes":0,"clipboardClearSeconds":0}', '{"autoLockMinutes":"5","clipboardClearSeconds":999999}'])(
  'falls back to safe defaults for invalid stored values: %s', value => {
    storage.set(SECURITY_PREFERENCES_KEY, value);
    expect(readSecurityPreferences()).toEqual({ autoLockMinutes: 15, clipboardClearSeconds: 30 });
  });

it('does not announce or apply an unsaved setting', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw Error('disk unavailable'); } });
  expect(() => setSecurityPreference('clipboardClearSeconds', 10)).toThrow('无法保存');
  expect(getClipboardClearMs()).toBe(30_000);
  expect(getSecurityPreferences().clipboardClearSeconds).toBe(30);
  expect(() => setSecurityPreference('autoLockMinutes', 0)).toThrow('不支持');
});
