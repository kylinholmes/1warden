// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickAccess } from './QuickAccess';

let node: HTMLDivElement; let root: Root;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(() => root.unmount()); node.remove(); vi.restoreAllMocks(); });
const accounts = [
  { id: 'one', email: 'one@example.test', serverUrl: 'https://one.example/team', displayName: 'Personal', avatarDataUrl: null },
  { id: 'two', email: 'two@example.test', serverUrl: 'https://two.example', displayName: '', avatarDataUrl: 'data:image/png;base64,broken' },
];
async function mount(extra: Record<string, unknown> = {}) {
  const props = { items: [], icons: null, locked: true, busy: false, notice: null, accounts,
    onQueryChange: vi.fn(), onPick: vi.fn(), onClose: vi.fn(), onOpenAccount: vi.fn(), ...extra };
  await act(() => root.render(createElement(QuickAccess, props as ComponentProps<typeof QuickAccess>)));
  return props;
}
const cards = () => [...node.querySelectorAll<HTMLButtonElement>('[data-quick-account]')];
it('shows account identity and explicit unlock action; activates the chosen account without any password input', async () => {
  const props = await mount();
  expect(cards()).toHaveLength(2);
  expect(cards()[0]!.getAttribute('aria-label')).toContain('Personal');
  expect(cards()[0]!.textContent).toContain('one@example.test');
  expect(cards()[0]!.title).toContain('https://one.example/team');
  expect(cards()[0]!.getAttribute('aria-label')).toContain('前往解锁');
  expect(cards()[0]!.querySelectorAll('[data-quick-account-label]')).toHaveLength(1);
  expect(node.querySelector('input[type=password]')).toBeNull();
  expect(node.querySelector('footer')!.textContent).not.toContain('复制密码');
  await act(() => cards()[1]!.click());
  expect(props.onOpenAccount).toHaveBeenCalledExactlyOnceWith('two');
  await act(() => cards()[1]!.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(cards()[1]!.querySelector('img')).toBeNull();
  expect(cards()[1]!.textContent).toContain('T');
});
it('focuses account cards and navigates horizontally without trapping modified keys or Escape', async () => {
  const props = await mount();
  expect(document.activeElement).toBe(cards()[0]);
  await act(() => cards()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(cards()[1]);
  const modified = new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, bubbles: true, cancelable: true });
  await act(() => cards()[1]!.dispatchEvent(modified));
  expect(modified.defaultPrevented).toBe(false); expect(document.activeElement).toBe(cards()[1]);
  await act(() => cards()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});
it('converts vertical wheel only when account overflow can scroll and leaves zoom and edges alone', async () => {
  await mount(); const rail = node.querySelector<HTMLElement>('[data-quick-account-rail]')!;
  Object.defineProperties(rail, { scrollWidth: { configurable: true, value: 800 }, clientWidth: { configurable: true, value: 400 } });
  const wheel = (deltaY: number, options = {}) => { const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options }); rail.dispatchEvent(e); return e; };
  expect(wheel(100).defaultPrevented).toBe(true); expect(rail.scrollLeft).toBe(100);
  expect(wheel(100, { ctrlKey: true }).defaultPrevented).toBe(false); expect(rail.scrollLeft).toBe(100);
  rail.scrollLeft = 400; expect(wheel(100).defaultPrevented).toBe(false);
  Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: 400 }); rail.scrollLeft = 0;
  expect(wheel(100).defaultPrevented).toBe(false);
});
it('offers a working main-window login when there are no remembered accounts and disables activation while busy', async () => {
  const props = await mount({ accounts: [] });
  const login = [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '打开 1Warden 登录')!;
  expect(login).toBeDefined(); await act(() => login.click());
  expect(props.onOpenAccount).toHaveBeenCalledExactlyOnceWith(null);
  await mount({ busy: true }); expect(cards().every(card => card.disabled)).toBe(true);
});
it('shows account loading instead of claiming there are no remembered accounts while awaiting main', async () => {
  await mount({ accounts: [], busy: true });
  expect(node.textContent).toContain('正在读取账户…');
  expect(node.textContent).not.toContain('还没有记住的账户');
});
