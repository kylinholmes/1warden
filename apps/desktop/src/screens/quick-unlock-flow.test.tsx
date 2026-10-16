// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickAccess } from './QuickAccess';
import type { QuickAuthResult } from '../quick-auth';

let node: HTMLDivElement; let root: Root;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const accounts = [
  { id: 'one', email: 'same@example.test', serverUrl: 'https://one.example/team', displayName: 'Personal', avatarDataUrl: null },
  { id: 'two', email: 'same@example.test', serverUrl: 'https://two.example', displayName: 'Work', avatarDataUrl: null },
];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(() => root.unmount()); node.remove(); vi.restoreAllMocks(); });
function result(stage: QuickAuthResult['stage'], extra = {}): QuickAuthResult {
  return { requestId: 1, generation: 1, accountId: 'one', stage, ...extra };
}
async function mount(extra: Partial<ComponentProps<typeof QuickAccess>> = {}) {
  const props = { items: [], icons: null, locked: true, busy: false, notice: null, accounts,
    onQueryChange: vi.fn(), onPick: vi.fn(), onClose: vi.fn(), onOpenAccount: vi.fn(), onCancelAuthentication: vi.fn(),
    onAuthenticationComplete: vi.fn(), onAuthenticate: vi.fn(async () => result('password')), ...extra };
  await act(() => root.render(createElement(QuickAccess, props)));
  return props;
}
async function input(selector: string, value: string) {
  const element = node.querySelector<HTMLInputElement>(selector)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(() => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function escape() { await act(() => (document.activeElement ?? node).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); }

it('selects an account, asks for its password here and continues search without opening main', async () => {
  const authenticate = vi.fn().mockResolvedValueOnce(result('password')).mockResolvedValueOnce(result('unlocked'));
  const props = await mount({ onAuthenticate: authenticate });
  await act(() => node.querySelector<HTMLButtonElement>('[data-quick-account="one"]')!.click());
  expect(node.textContent).toContain('one.example/team');
  expect(document.activeElement).toBe(node.querySelector('input[type=password]'));
  await input('input[type=password]', 'synthetic-password'); await submit();
  expect(authenticate).toHaveBeenLastCalledWith('one', { action: 'password', password: 'synthetic-password' });
  expect(props.onAuthenticationComplete).toHaveBeenCalledOnce();
  expect(props.onOpenAccount).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  await act(() => root.render(createElement(QuickAccess, { ...props, locked: false })));
  expect(document.activeElement).toBe(node.querySelector('[aria-label="搜索保险库"]'));
});
it('opens a single account directly and restores input focus after a wrong password', async () => {
  let reply!: (value: QuickAuthResult) => void;
  const authenticate = vi.fn().mockResolvedValueOnce(result('password'))
    .mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  await mount({ accounts: accounts.slice(0, 1), onAuthenticate: authenticate });
  expect(node.querySelectorAll('[data-quick-account]')).toHaveLength(0);
  await input('input[type=password]', 'wrong'); await submit();
  const field = node.querySelector<HTMLInputElement>('input[type=password]')!;
  expect(field.disabled).toBe(true); expect(field.value).toBe('');
  await act(() => reply(result('password', { error: '主密码不正确' })));
  expect(node.querySelector('[role=alert]')!.textContent).toContain('主密码不正确');
  expect(field.disabled).toBe(false); expect(document.activeElement).toBe(field);
});
it('finishes two-factor in the same window and returns to password on Escape', async () => {
  const authenticate = vi.fn().mockResolvedValueOnce(result('password'))
    .mockResolvedValueOnce(result('twoFactor', { providers: [7, 0] }));
  const props = await mount({ accounts: accounts.slice(0, 1), onAuthenticate: authenticate });
  await input('input[type=password]', 'synthetic-password'); await submit();
  expect(node.querySelector('[aria-label="验证码"]')).not.toBeNull();
  expect(node.querySelector('input[type=password]')).toBeNull();
  await escape();
  expect(document.activeElement).toBe(node.querySelector('input[type=password]'));
  expect(props.onCancelAuthentication).toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  await escape(); expect(props.onClose).toHaveBeenCalledOnce();
});
it('ignores successful authentication after returning to account choices', async () => {
  let reply!: (value: QuickAuthResult) => void;
  const authenticate = vi.fn().mockResolvedValueOnce(result('password'))
    .mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const props = await mount({ onAuthenticate: authenticate });
  await act(() => node.querySelector<HTMLButtonElement>('[data-quick-account="one"]')!.click());
  await input('input[type=password]', 'synthetic-password'); await submit();
  await act(() => node.querySelector<HTMLButtonElement>('[aria-label="返回选择账户"]')!.click());
  await act(() => reply(result('unlocked')));
  expect(node.querySelectorAll('[data-quick-account]')).toHaveLength(2);
  expect(props.onAuthenticationComplete).not.toHaveBeenCalled();
});
it('routes Escape from the header pin through the active authentication step', async () => {
  const props = await mount({ onTogglePin: vi.fn() });
  await act(() => node.querySelector<HTMLButtonElement>('[data-quick-account="one"]')!.click());
  node.querySelector<HTMLButtonElement>('[aria-label="固定快速搜索"]')!.focus();
  await escape();
  expect(node.querySelectorAll('[data-quick-account]')).toHaveLength(2);
  expect(props.onClose).not.toHaveBeenCalled();
});
it('keeps search text across lock and unlock and permits choosing another account', async () => {
  const props = await mount({ locked: false });
  await input('[aria-label="搜索保险库"]', 'github');
  await act(() => root.render(createElement(QuickAccess, { ...props, locked: true })));
  expect(node.querySelector<HTMLInputElement>('[aria-label="搜索保险库"]')!.value).toBe('github');
  await act(() => root.render(createElement(QuickAccess, { ...props, locked: false })));
  expect(document.activeElement).toBe(node.querySelector('[aria-label="搜索保险库"]'));
  await act(() => node.querySelector<HTMLButtonElement>('[aria-label="切换搜索账户"]')!.click());
  expect(node.querySelectorAll('[data-quick-account]')).toHaveLength(2);
});
