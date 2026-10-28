// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { buildPreferencesItem, parseProfileSettings } from '@1warden/vault';
import { AppearancePicker } from './AppearancePicker';
import { applyPreferences, localPreferences } from '../account-preferences';
import { getThemeMode, getThemePalette, initTheme, setThemePalette } from '../theme';
import { PALETTES } from '../theme-palettes';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it('uses clear-blue for unsupported account palettes and retains explicit original selections', () => {
  initTheme(); setThemePalette('original');
  applyPreferences({ mode: 'dark', palette: 'future-palette', showTypes: true });
  expect(getThemePalette()).toBe('clear-blue'); expect(getThemeMode()).toBe('dark');
  applyPreferences({ mode: 'light', palette: 'original', showTypes: true });
  expect(getThemePalette()).toBe('original'); expect(getThemeMode()).toBe('light');
});
it('makes all palettes keyboard reachable and roundtrips new selections through account settings', async () => {
  initTheme(); setThemePalette('original');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const changed = vi.fn();
  try {
    await act(() => root.render(<AppearancePicker onChange={changed} />));
    const trigger = () => host.querySelector<HTMLButtonElement>('.palette-trigger')!;
    const key = async (value: string) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
    await act(() => trigger().click());
    expect([...host.querySelectorAll('[role="option"]')].map(x => x.textContent)).toEqual(PALETTES.map(x => `Aa${x.name}`));
    await key('End'); expect(document.activeElement?.textContent).toBe('AaLinear');
    await key('Home'); expect(document.activeElement?.textContent).toBe('Aa1Warden');
    const trialPalettes = ['jade', 'clear-blue', 'whale', 'brass'] as const;
    for (const palette of trialPalettes) {
      await key('ArrowDown');
      expect(document.activeElement?.id.endsWith(`-${palette}`)).toBe(true);
      await act(() => (document.activeElement as HTMLButtonElement).click());
      expect(getThemePalette()).toBe(palette); expect(document.activeElement).toBe(trigger());
      const remote = parseProfileSettings(buildPreferencesItem(localPreferences())).preferences!;
      await act(() => setThemePalette('original'));
      await act(() => applyPreferences(remote));
      expect(getThemePalette()).toBe(palette); expect(localStorage.getItem('1warden.palette')).toBe(palette);
      expect(changed).toHaveBeenCalledTimes(trialPalettes.indexOf(palette) + 1);
      await act(() => trigger().click());
    }
    await key('Escape'); expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  } finally { await act(() => root.unmount()); host.remove(); }
});
