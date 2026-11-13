import { createStore } from '@1warden/state';
import { setClipboardClearMs } from '@1warden/ui/clipboard';

export const SECURITY_PREFERENCES_KEY = '1warden.security.preferences';
export const AUTO_LOCK_MINUTES = [1, 5, 15, 30, 60] as const;
export const CLIPBOARD_CLEAR_SECONDS = [10, 30, 60, 120] as const;
export interface SecurityPreferences { autoLockMinutes: number; clipboardClearSeconds: number }
const defaults: SecurityPreferences = { autoLockMinutes: 15, clipboardClearSeconds: 30 };

export function readSecurityPreferences(): SecurityPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SECURITY_PREFERENCES_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { ...defaults };
    const prefs = value as Partial<SecurityPreferences>;
    return {
      autoLockMinutes: AUTO_LOCK_MINUTES.some(n => n === prefs.autoLockMinutes) ? prefs.autoLockMinutes! : defaults.autoLockMinutes,
      clipboardClearSeconds: CLIPBOARD_CLEAR_SECONDS.some(n => n === prefs.clipboardClearSeconds) ? prefs.clipboardClearSeconds! : defaults.clipboardClearSeconds,
    };
  } catch { return { ...defaults }; }
}

export const securityPreferencesStore = createStore(() => readSecurityPreferences());
export const getSecurityPreferences = () => securityPreferencesStore.getState();

/** Called by the native/mobile application owner, never by the extension popup. */
export function initializeSecurityPreferences(): void {
  const value = readSecurityPreferences();
  setClipboardClearMs(value.clipboardClearSeconds * 1000);
  securityPreferencesStore.setState(value);
}

/** Persist first: a failed write must not claim a durable security setting. */
export function setSecurityPreference<K extends keyof SecurityPreferences>(key: K, value: SecurityPreferences[K]): void {
  const options: readonly number[] = key === 'autoLockMinutes' ? AUTO_LOCK_MINUTES : CLIPBOARD_CLEAR_SECONDS;
  if (!options.includes(value)) throw new Error('不支持的安全时限');
  const next = { ...getSecurityPreferences(), [key]: value };
  try { localStorage.setItem(SECURITY_PREFERENCES_KEY, JSON.stringify(next)); }
  catch { throw new Error('无法保存安全设置，请检查本地存储后重试'); }
  setClipboardClearMs(next.clipboardClearSeconds * 1000);
  securityPreferencesStore.setState(next);
}
