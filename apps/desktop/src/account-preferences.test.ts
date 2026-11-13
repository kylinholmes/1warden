import { describe, it, expect, vi } from 'vitest';
import { createPreferencesProjection } from './account-preferences';
import { EMPTY_SNAPSHOT, type ApplicationSnapshot } from './application/types';
import { DEFAULT_PROFILE_PREFERENCES } from '@1warden/vault';
const legacy = { mode: 'dark' as const, palette: 'dracula', showTypes: false };
const account = { serverUrl: 'https://vault.example', email: 'a@example.com', userId: 'a', kdf: { kdf: 0 as const, iterations: 1000 } };
const unlocked: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, account, status: 'unlocked', profileReady: true };
function fixture() {
  const values = new Map<string, string>();
  const apply = vi.fn();
  const receive = createPreferencesProjection({ apply, readLocal: () => legacy, storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
  } });
  return { receive, apply, values };
}
describe('account presentation projection', () => {
  it('migrates legacy appearance only for the first account, not subsequent accounts', () => {
    const { receive, apply } = fixture(); receive(unlocked);
    expect(apply).toHaveBeenLastCalledWith(legacy);
    receive({ ...unlocked, account: { ...account, email: 'b@example.com' } });
    expect(apply).toHaveBeenLastCalledWith(DEFAULT_PROFILE_PREFERENCES);
    expect(apply.mock.lastCall?.[0]).toMatchObject({ mode: 'system', palette: 'clear-blue' });
    receive(unlocked); expect(apply).toHaveBeenLastCalledWith(legacy);
  });
  it('applies server preferences once, does not echo writes and ignores unrelated device updates', () => {
    const { receive, apply, values } = fixture();
    const settings = { preferences: legacy, devices: [] };
    receive({ ...unlocked, profileSettings: settings });
    receive({ ...unlocked, revision: 10, profileSettings: settings });
    expect(apply).toHaveBeenCalledTimes(1);
    for (const value of values.values()) expect(value).not.toContain('devices');
    const remote = { ...legacy, palette: 'github' };
    receive({ ...unlocked, profileSettings: { ...settings, preferences: remote } });
    expect(apply).toHaveBeenLastCalledWith(remote);
  });
  it('previews account-local settings without persisting before verified sync and reapplies after unlock', () => {
    const { receive, apply, values } = fixture();
    receive({ ...unlocked, profileReady: false }); expect(apply).toHaveBeenLastCalledWith(legacy); expect(values.size).toBe(0);
    receive({ ...unlocked, profileSettingsError: 'future' }); expect(apply).toHaveBeenCalledTimes(1); expect(values.size).toBe(0);
    receive(unlocked); receive({ ...unlocked, status: 'locked' }); receive(unlocked);
    expect(apply).toHaveBeenCalledTimes(3);
  });
  it('uses a new account cache or defaults while unverified, never the previous account appearance', () => {
    const { receive, apply, values } = fixture(); receive({ ...unlocked, profileSettings: { preferences: legacy, devices: [] } });
    const b = { ...account, email: 'b@example.com' };
    const bKey = `1warden.preferences.v1.${JSON.stringify([b.serverUrl, b.email])}`;
    receive({ ...unlocked, account: b, profileReady: false, syncing: true });
    expect(apply).toHaveBeenLastCalledWith(DEFAULT_PROFILE_PREFERENCES); expect(values.has(bKey)).toBe(false);
    const cached = { ...legacy, mode: 'light' as const, palette: 'brass' };
    values.set(bKey, JSON.stringify(cached)); receive(unlocked);
    receive({ ...unlocked, account: b, profileReady: false, syncing: true });
    expect(apply).toHaveBeenLastCalledWith(cached);
  });
  it('treats corrupt caches as untrusted and clears the presentation cache on logout', () => {
    const { receive, values } = fixture();
    const key = `1warden.preferences.v1.${JSON.stringify([account.serverUrl, account.email])}`;
    values.set(key, '{'); receive(unlocked);
    expect(JSON.parse(values.get(key)!)).toEqual(legacy);
    receive({ ...unlocked, status: 'locked' });
    receive(EMPTY_SNAPSHOT); expect(values.has(key)).toBe(false);
  });
});
