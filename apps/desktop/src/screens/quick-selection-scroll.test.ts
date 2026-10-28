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
      const selected = host.querySelector('[role="option"][aria-selected="true"]');
      expect(selected?.textContent).toContain(`Fixture ${i}`);
      expect(scroll.mock.contexts.at(-1)).toBe(selected);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      expect(document.activeElement).toBe(search);
    }
    await key('Enter'); expect(onPick).toHaveBeenCalledExactlyOnceWith(items[11]);
    await key('ArrowUp');
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fixture 10');
    expect(scroll.mock.contexts.at(-1)).toBe(host.querySelector('[role="option"][aria-selected="true"]'));
    await act(() => root!.render(createElement(QuickAccess, { ...props, items: items.slice(0, 2) })));
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fixture 1');
    expect(scroll.mock.contexts.at(-1)).toBe(host.querySelector('[role="option"][aria-selected="true"]'));
    expect(document.activeElement).toBe(search);
  });
});

async function mount(extra: Partial<ComponentProps<typeof QuickAccess>> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const props: ComponentProps<typeof QuickAccess> = { items, icons: null, locked: false, busy: false, notice: null,
    onQueryChange: vi.fn(), onPick: vi.fn(), onClose: vi.fn(), ...extra };
  await act(() => root!.render(createElement(QuickAccess, props)));
  return props;
}
function activeOption() {
  const input = host!.querySelector('input')!;
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}
it('links input/listbox/options, retains identity on refresh/reorder and clamps removed rows', async () => {
  const props = await mount(); const input = host!.querySelector('input')!;
  expect(input.getAttribute('role')).toBe('combobox');
  expect(input.getAttribute('aria-controls')).toBe(host!.querySelector('[role=listbox]')!.id);
  expect(input.getAttribute('aria-expanded')).toBe('true');
  expect(host!.querySelector('[role=status]')?.textContent).toBe('12 个搜索结果');
  expect(host!.querySelector('[role=option] button')).toBeNull();
  await key('ArrowDown'); await key('ArrowDown'); const id = activeOption()!.id;
  expect(activeOption()?.textContent).toContain('Fixture 2');
  await act(() => root!.render(createElement(QuickAccess, { ...props, items: [...items].reverse() })));
  expect(activeOption()!.id).toBe(id); expect(activeOption()?.getAttribute('aria-selected')).toBe('true');
  await key('Enter'); expect(props.onPick).toHaveBeenLastCalledWith(items[2]);
  await act(() => root!.render(createElement(QuickAccess, { ...props, items: items.slice(0, 2) })));
  expect(activeOption()?.textContent).toContain('Fixture 1');
  expect(document.activeElement).toBe(input);
  await act(() => root!.render(createElement(QuickAccess, { ...props, items: [] })));
  expect(activeOption()).toBeNull(); expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  await key('ArrowDown'); await key('ArrowUp'); await key('Enter');
  expect(props.onPick).toHaveBeenCalledTimes(1);
  await act(() => root!.render(createElement(QuickAccess, { ...props, items: items.slice(0, 1) })));
  expect(activeOption()?.textContent).toContain('Fixture 0');
});
it('announces no results after typing and preserves busy/no-password copy guards and mouse focus', async () => {
  const props = await mount({ items: [] }); const input = host!.querySelector('input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(props.onQueryChange).toHaveBeenCalledWith('missing', 1);
  expect(host!.querySelector('[role=status]')?.textContent).toBe('没有匹配条目');
  const noPassword = { ...items[0]!, id: 'no password / 合成', hasPassword: false };
  for (const extra of [{ busy: true, items: [items[0]!] }, { busy: false, items: [noPassword] }]) {
    await act(() => root!.render(createElement(QuickAccess, { ...props, ...extra })));
    const option = activeOption()!; expect(option.getAttribute('aria-disabled')).toBe('true');
    await key('Enter'); await act(() => (option as HTMLElement).click());
  }
  expect(props.onPick).not.toHaveBeenCalled();
  await act(() => root!.render(createElement(QuickAccess, { ...props, items: [items[0]!] })));
  const option = activeOption()!;
  await act(() => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    (option as HTMLElement).click();
  });
  expect(props.onPick).toHaveBeenCalledExactlyOnceWith(items[0]); expect(document.activeElement).toBe(input);
});
it('leaves text editing keys and composition alone, and closes with Escape', async () => {
  const props = await mount(); const input = host!.querySelector('input')!;
  for (const options of [{ key: 'Home' }, { key: 'End' }, { key: 'ArrowDown', shiftKey: true }, { key: 'Enter', isComposing: true }]) {
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
    await act(() => input.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
  }
  expect(props.onPick).not.toHaveBeenCalled();
  await key('Escape'); expect(props.onClose).toHaveBeenCalledOnce();
});
