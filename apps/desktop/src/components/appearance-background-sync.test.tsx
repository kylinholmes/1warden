// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import { getThemeMode, initTheme, setThemeMode } from '../theme';
import { ProfileAutosaveProvider } from './ProfileAutosave';
import { AccountMetadataProvider } from './AccountMetadata';
import { AccountAppearance } from './AccountAppearance';
import { ProfileEditor } from './ProfileEditor';
import { applyPreferences, localPreferences } from '../account-preferences';
import { DEFAULT_PROFILE_PREFERENCES } from '@1warden/vault';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it('keeps appearance and profile inputs responsive from first sync, merges remote settings, and guards locked accounts', async () => {
  initTheme(); setThemeMode('light');
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', syncing: true,
    account: { serverUrl: 'https://synthetic.invalid', email: 'fixture@example.invalid', userId: 'test', kdf: { kdf: 0, iterations: 1 } } };
  const listeners = new Set<() => void>();
  const update = async (patch: Partial<ApplicationSnapshot>) => act(async () => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); });
  const savePreferences = vi.fn(async preferences => {
    snapshot = { ...snapshot, profileSettings: { preferences, devices: [] } }; listeners.forEach(fn => fn());
  });
  const saveProfile = vi.fn(async profile => { snapshot = { ...snapshot, profile }; listeners.forEach(fn => fn()); });
  const client = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    capabilities: { native: false, browser: false, saveAttachments: false }, recordDevice: async () => {}, savePreferences, saveProfile } as unknown as ApplicationClient;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const dark = () => host.querySelector<HTMLButtonElement>('.appearance-mode:has(.mode-dark)')!;
  try {
    await act(() => root.render(<ProfileAutosaveProvider client={client}><AccountMetadataProvider client={client}>
      <AccountAppearance client={client} /><ProfileEditor client={client} />
    </AccountMetadataProvider></ProfileAutosaveProvider>));
    expect(dark().matches(':disabled')).toBe(false);
    await act(() => dark().click());
    expect(getThemeMode()).toBe('dark'); expect(host.textContent).toContain('已在本机生效');
    const name = host.querySelector<HTMLInputElement>('#profile-name')!;
    expect(name.disabled).toBe(false);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Draft while syncing');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(name.value).toBe('Draft while syncing');
    expect(savePreferences).not.toHaveBeenCalled(); expect(saveProfile).not.toHaveBeenCalled();
    await update({ syncing: false, profileReady: true, profile: { displayName: 'Remote', avatarDataUrl: null },
      profileSettings: { preferences: { mode: 'light', palette: 'dracula', showTypes: false, iconStyle: 'plate' }, devices: [] } });
    expect(getThemeMode()).toBe('dark');
    expect(document.documentElement.dataset.palette).toBe('dracula');
    const picker = host.querySelector('.appearance-picker');
    expect(dark().matches(':disabled')).toBe(false);
    await update({ syncing: true, profileReady: false });
    expect(dark().matches(':disabled')).toBe(false);
    await act(() => dark().click());
    expect(getThemeMode()).toBe('dark'); expect(host.textContent).toContain('等待自动保存');
    expect(savePreferences).not.toHaveBeenCalled();
    expect(host.querySelector('.appearance-picker')).toBe(picker);
    await update({ status: 'locked', syncing: false });
    expect(dark().matches(':disabled')).toBe(true);
    expect(name.disabled).toBe(true);
    await update({ status: 'unlocked', syncing: true });
    expect(dark().matches(':disabled')).toBe(false);
    await update({ syncing: false, syncError: 'Synthetic offline' });
    await act(() => host.querySelector<HTMLButtonElement>('.appearance-mode:has(.mode-light)')!.click());
    expect(getThemeMode()).toBe('light'); expect(host.textContent).toContain('Synthetic offline');
    expect(savePreferences).not.toHaveBeenCalled();
  } finally { await act(() => root.unmount()); host.remove(); localStorage.clear(); }
});

it.each(['legacy', 'new-account', 'cached-account'] as const)('preserves only the current account %s preview when first sync has no remote preferences', async scenario => {
  vi.useFakeTimers(); localStorage.clear(); initTheme();
  const legacy = { mode: 'dark' as const, palette: 'jade', showTypes: false, iconStyle: 'original' as const };
  const cached = { mode: 'light' as const, palette: 'brass', showTypes: false, iconStyle: 'original' as const };
  applyPreferences(legacy);
  const account = { serverUrl: 'https://synthetic.invalid', email: 'a@example.invalid', userId: 'test', kdf: { kdf: 0 as const, iterations: 1 } };
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', syncing: scenario === 'legacy', profileReady: scenario !== 'legacy', account,
    profileSettings: scenario === 'legacy' ? null : { preferences: legacy, devices: [] } };
  const listeners = new Set<() => void>();
  const update = async (patch: Partial<ApplicationSnapshot>) => act(async () => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); });
  const savePreferences = vi.fn(async preferences => { snapshot = { ...snapshot, profileSettings: { preferences, devices: [] } }; listeners.forEach(fn => fn()); });
  const client = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    capabilities: { native: false, browser: false, saveAttachments: false }, recordDevice: async () => {}, savePreferences } as unknown as ApplicationClient;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<ProfileAutosaveProvider client={client}><AccountMetadataProvider client={client}>
      <AccountAppearance client={client} />
    </AccountMetadataProvider></ProfileAutosaveProvider>));
    if (scenario !== 'legacy') {
      const b = { ...account, email: 'b@example.invalid' };
      if (scenario === 'cached-account') localStorage.setItem(`1warden.preferences.v1.${JSON.stringify([b.serverUrl, b.email])}`, JSON.stringify(cached));
      await update({ account: b, syncing: true, profileReady: false, profileSettings: null });
    }
    const expected = scenario === 'legacy' ? legacy : scenario === 'cached-account' ? cached : DEFAULT_PROFILE_PREFERENCES;
    expect(localPreferences()).toEqual(expected);
    const plate = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === '统一底板')!;
    await act(() => plate.click());
    expect(localPreferences()).toEqual({ ...expected, iconStyle: 'plate' });
    expect(savePreferences).not.toHaveBeenCalled();
    await update({ syncing: false, profileReady: true, profileSettings: { preferences: null, devices: [] } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ ...expected, iconStyle: 'plate' }, null);
    expect(localPreferences()).toEqual({ ...expected, iconStyle: 'plate' });
  } finally { await act(() => root.unmount()); host.remove(); localStorage.clear(); vi.useRealTimers(); }
});
