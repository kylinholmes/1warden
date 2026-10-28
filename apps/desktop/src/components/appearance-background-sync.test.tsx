// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import { getThemeMode, initTheme, setThemeMode } from '../theme';
import { ProfileAutosaveProvider } from './ProfileAutosave';
import { AccountMetadataProvider } from './AccountMetadata';
import { AccountAppearance } from './AccountAppearance';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it('keeps the real appearance controls responsive during background sync, with initial and lock guards', async () => {
  initTheme(); setThemeMode('light');
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', syncing: true,
    account: { serverUrl: 'https://synthetic.invalid', email: 'fixture@example.invalid', userId: 'test', kdf: { kdf: 0, iterations: 1 } } };
  const listeners = new Set<() => void>();
  const update = async (patch: Partial<ApplicationSnapshot>) => act(async () => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); });
  const savePreferences = vi.fn();
  const client = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    capabilities: { native: false, browser: false, saveAttachments: false }, recordDevice: async () => {}, savePreferences } as unknown as ApplicationClient;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const dark = () => host.querySelector<HTMLButtonElement>('.appearance-mode:has(.mode-dark)')!;
  try {
    await act(() => root.render(<ProfileAutosaveProvider client={client}><AccountMetadataProvider client={client}>
      <AccountAppearance client={client} />
    </AccountMetadataProvider></ProfileAutosaveProvider>));
    expect(dark().matches(':disabled')).toBe(true);
    await update({ syncing: false, profileReady: true });
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
    await update({ status: 'unlocked', syncing: true });
    expect(dark().matches(':disabled')).toBe(true);
  } finally { await act(() => root.unmount()); host.remove(); localStorage.clear(); }
});
