// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ItemIcon } from '@1warden/ui';
import type { IconStore } from '@1warden/vault';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); delete document.documentElement.dataset.iconStyle; });
it.each(['original', 'plate'])('identifies notes by supplied title abbreviation without requesting a brand or favicon (%s)', async iconStyle => {
  document.documentElement.dataset.iconStyle = iconStyle;
  const get = vi.fn(async () => 'https://synthetic.invalid/icon.png');
  const store = { get } as unknown as IconStore;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (text: string, iconDomain: string | null, size?: number) => root.render(createElement(ItemIcon, {
    type: 'secureNote', text, hue: 210, iconDomain, store, ...(size === undefined ? {} : { size }),
  }));
  try {
    await act(() => render('工作', 'github.com'));
    expect(host.querySelector('.tile-note-text')?.textContent).toBe('工作');
    expect(host.querySelector('.tile-note-mark svg')).not.toBeNull();
    expect(host.querySelector('img, [data-service-brand], .tile-glyph')).toBeNull();
    expect(host.querySelector<HTMLElement>('.tile-note')?.style.getPropertyValue('--h')).toBe('210');
    expect(get).not.toHaveBeenCalled();
    await act(() => render('旅行', 'unknown.synthetic.invalid', 36));
    expect(host.querySelector('.tile-note-text')?.textContent).toBe('旅行');
    expect(host.querySelector<HTMLElement>('.tile-note')?.style.getPropertyValue('--tile-size')).toBe('36px');
    expect(get).not.toHaveBeenCalled();
    await act(() => render('AB', null, 34));
    expect(host.querySelector('.tile-note-text')?.textContent).toBe('AB');
    expect(host.querySelector<HTMLElement>('.tile-note')?.style.getPropertyValue('--tile-size')).toBe('34px');
    expect(get).not.toHaveBeenCalled();
  } finally { await act(() => root.unmount()); }
});
