// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAccess } from './QuickAccess';
import type { QuickItem } from '../quick-bridge';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const scroll = vi.fn();
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  scroll.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
});
const items: QuickItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(i), name: `Fixture ${i}`, username: null, hasPassword: true, hasTotp: false,
  type: 'login', summary: null, iconDomain: null, avatarText: 'T', avatarHue: 0,
}));
async function key(key: string) {
  await act(() => host!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
}
describe('QuickAccess keeps keyboard selection visible', () => {
  it('scrolls every keyboard selection into view without stealing search focus', async () => {
    const onPick = vi.fn();
    const props: ComponentProps<typeof QuickAccess> = { items, icons: null, locked: false, busy: false, notice: null,
      onQueryChange: vi.fn(), onPick, onClose: vi.fn() };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(() => root!.render(createElement(QuickAccess, props)));
    const search = host.querySelector('input');
    for (let i = 1; i < items.length; i++) {
      await key('ArrowDown');
      const selected = host.querySelector('button[aria-current="true"]');
      expect(selected?.textContent).toContain(`Fixture ${i}`);
      expect(scroll.mock.contexts.at(-1)).toBe(selected);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      expect(document.activeElement).toBe(search);
    }
    await key('Enter'); expect(onPick).toHaveBeenCalledExactlyOnceWith(items[11]);
    await key('ArrowUp');
    expect(host.querySelector('button[aria-current="true"]')?.textContent).toContain('Fixture 10');
    expect(scroll.mock.contexts.at(-1)).toBe(host.querySelector('button[aria-current="true"]'));
    await act(() => root!.render(createElement(QuickAccess, { ...props, items: items.slice(0, 2) })));
    expect(host.querySelector('button[aria-current="true"]')?.textContent).toContain('Fixture 0');
    expect(scroll.mock.contexts.at(-1)).toBe(host.querySelector('button[aria-current="true"]'));
    expect(document.activeElement).toBe(search);
  });
});
