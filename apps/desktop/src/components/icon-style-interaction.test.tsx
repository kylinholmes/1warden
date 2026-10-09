// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppearancePicker } from './AppearancePicker';
import { applyPreferences, localPreferences, subscribePreferences } from '../account-preferences';
import { getIconStyle, initTheme, setIconStyle } from '../theme';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it('changes icon style immediately and routes actual edits through the synchronized preference callback', async () => {
  initTheme(); setIconStyle('original');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const changed = vi.fn();
  const notification = vi.fn(); const unsubscribe = subscribePreferences(notification);
  try {
    await act(() => root.render(<AppearancePicker onChange={changed} />));
    const choices = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="图标样式"] button')];
    expect(choices().find(button => button.textContent === '原貌')?.getAttribute('aria-checked')).toBe('true');
    await act(() => choices().find(button => button.textContent === '统一底板')!.click());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(getIconStyle()).toBe('plate');
    expect(document.documentElement.dataset.iconStyle).toBe('plate');
    expect(localPreferences().iconStyle).toBe('plate');
    // Legacy account preferences reset the rendering to the supported default,
    // but receiving them must not enqueue another user-originated save.
    await act(() => applyPreferences({ mode: 'system', palette: 'original', showTypes: true }));
    expect(getIconStyle()).toBe('original');
    expect(choices().find(button => button.textContent === '原貌')?.getAttribute('aria-checked')).toBe('true');
    expect(changed).toHaveBeenCalledTimes(1);
    const original = choices().find(button => button.textContent === '原貌')!;
    await act(() => { original.focus(); original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(getIconStyle()).toBe('plate');
    expect(document.activeElement?.textContent).toBe('统一底板');
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); await act(() => root.unmount()); host.remove(); }
});
