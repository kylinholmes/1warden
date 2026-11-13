import { DEFAULT_PROFILE_PREFERENCES, validatePreferences, type ProfilePreferences } from '@1warden/vault';
import type { ApplicationSnapshot } from './application/types';
import { getThemeMode, getThemePalette, getIconStyle, setThemeMode, setThemePalette, setIconStyle, subscribeTheme } from './theme';
import { DEFAULT_PALETTE, isPalette } from './theme-palettes';
import { getShowTypes, setShowTypes, subscribeShowTypes } from './prefs';

export function localPreferences(): ProfilePreferences {
  return { mode: getThemeMode(), palette: getThemePalette(), showTypes: getShowTypes(), iconStyle: getIconStyle() };
}
export const localPreferencesSignature = () => JSON.stringify(localPreferences());
export function subscribePreferences(fn: () => void): () => void {
  const a = subscribeTheme(fn); const b = subscribeShowTypes(fn); return () => { a(); b(); };
}
export function applyPreferences(value: ProfilePreferences): void {
  setThemeMode(value.mode); setThemePalette(isPalette(value.palette) ? value.palette : DEFAULT_PALETTE); setShowTypes(value.showTypes);
  setIconStyle(value.iconStyle ?? 'original');
}

/** Read-only projection: receiving a sync must never echo a write back to the vault. */
export function createPreferencesProjection(options: {
  readLocal: () => ProfilePreferences;
  apply: (value: ProfilePreferences) => void;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) {
  let previous = '';
  let previousAccount: string | null = null;
  let lastStatus = '';
  const localFallbacks = new Map<string, ProfilePreferences>();
  function localFallback(account: string, key: string): ProfilePreferences {
    try { const cache = options.storage.getItem(key); if (cache) return validatePreferences(JSON.parse(cache)); } catch { /* cache is untrusted */ }
    const existing = localFallbacks.get(account);
    if (existing) return existing;
    let migrated = true;
    try { migrated = options.storage.getItem('1warden.preferences.migrated') === '1'; } catch { /* safe defaults */ }
    // Only the first account may inherit legacy device preferences. A new
    // account without its own cache must never inherit another account's theme.
    const value = !migrated && previousAccount === null ? options.readLocal() : { ...DEFAULT_PROFILE_PREFERENCES };
    localFallbacks.set(account, value);
    return value;
  }
  return (snapshot: ApplicationSnapshot) => {
    const account = snapshot.account ? JSON.stringify([snapshot.account.serverUrl.replace(/\/$/, ''), snapshot.account.email.toLowerCase()]) : null;
    const key = account ? `1warden.preferences.v1.${account}` : null;
    if (lastStatus !== 'loggedOut' && snapshot.status === 'loggedOut' && previousAccount) {
      try { options.storage.removeItem(`1warden.preferences.v1.${previousAccount}`); } catch { /* optional cache */ }
      localFallbacks.delete(previousAccount);
    }
    lastStatus = snapshot.status;
    if (!account || !key || snapshot.status !== 'unlocked') { previous = ''; return; }
    if (!snapshot.profileReady || snapshot.profileError || snapshot.profileSettingsError || snapshot.syncing || snapshot.syncError) {
      if (account !== previousAccount || previous === '') {
        options.apply(localFallback(account, key));
        previous = JSON.stringify([account, 'local']); previousAccount = account;
      }
      return;
    }
    const remote = snapshot.profileSettings?.preferences ?? null;
    const signature = JSON.stringify([account, remote]);
    if (signature === previous) return;
    const value = remote ?? localFallback(account, key);
    options.apply(value);
    try { options.storage.setItem(key, JSON.stringify(validatePreferences(value))); options.storage.setItem('1warden.preferences.migrated', '1'); } catch { /* session-only */ }
    previous = signature; previousAccount = account;
  };
}
