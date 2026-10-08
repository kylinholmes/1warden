import { DEFAULT_PROFILE_PREFERENCES, validatePreferences, type ProfilePreferences } from '@1warden/vault';
import type { ApplicationSnapshot } from './application/types';
import { getThemeMode, getThemePalette, setThemeMode, setThemePalette, subscribeTheme } from './theme';
import { isPalette } from './theme-palettes';
import { getShowTypes, setShowTypes, subscribeShowTypes } from './prefs';

export function localPreferences(): ProfilePreferences {
  return { mode: getThemeMode(), palette: getThemePalette(), showTypes: getShowTypes() };
}
export const localPreferencesSignature = () => JSON.stringify(localPreferences());
export function subscribePreferences(fn: () => void): () => void {
  const a = subscribeTheme(fn); const b = subscribeShowTypes(fn); return () => { a(); b(); };
}
export function applyPreferences(value: ProfilePreferences): void {
  setThemeMode(value.mode); setThemePalette(isPalette(value.palette) ? value.palette : 'original'); setShowTypes(value.showTypes);
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
  return (snapshot: ApplicationSnapshot) => {
    const account = snapshot.account ? JSON.stringify([snapshot.account.serverUrl.replace(/\/$/, ''), snapshot.account.email.toLowerCase()]) : null;
    const key = account ? `1warden.preferences.v1.${account}` : null;
    if (lastStatus !== 'loggedOut' && snapshot.status === 'loggedOut' && previousAccount) {
      try { options.storage.removeItem(`1warden.preferences.v1.${previousAccount}`); } catch { /* optional cache */ }
    }
    lastStatus = snapshot.status;
    if (!account || !key || snapshot.status !== 'unlocked') { previous = ''; return; }
    if (!snapshot.profileReady || snapshot.profileError || snapshot.profileSettingsError) return;
    const remote = snapshot.profileSettings?.preferences ?? null;
    const signature = JSON.stringify([account, remote]);
    if (signature === previous) return;
    let value = remote;
    if (!value) {
      try { const cache = options.storage.getItem(key); if (cache) value = validatePreferences(JSON.parse(cache)); } catch { /* cache is untrusted */ }
      if (!value) {
        let migrated = true;
        try { migrated = options.storage.getItem('1warden.preferences.migrated') === '1'; } catch { /* safe defaults */ }
        value = !migrated && previousAccount === null ? options.readLocal() : { ...DEFAULT_PROFILE_PREFERENCES };
      }
    }
    options.apply(value);
    try { options.storage.setItem(key, JSON.stringify(validatePreferences(value))); options.storage.setItem('1warden.preferences.migrated', '1'); } catch { /* session-only */ }
    previous = signature; previousAccount = account;
  };
}
