// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecuritySettings } from './SecuritySettings';
import { getSecurityPreferences, initializeSecurityPreferences, SECURITY_PREFERENCES_KEY } from '../security-preferences';
import { getClipboardClearMs } from '@1warden/ui/clipboard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let element: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); initializeSecurityPreferences();
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(() => root.unmount()); element.remove(); vi.restoreAllMocks();
  localStorage.clear(); initializeSecurityPreferences();
});
async function select(label: string, value: string) {
  await act(() => element.querySelector<HTMLButtonElement>(`[role="combobox"][aria-labelledby="${label}"]`)!.click());
  await act(() => element.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!.click());
}

it('edits and persists both settings without any server/client dependency', async () => {
  await act(() => root.render(<SecuritySettings browser={false} windows />));
  await select('security-lock-label', '5');
  await select('security-clipboard-label', '10');
  expect(getSecurityPreferences()).toEqual({ autoLockMinutes: 5, clipboardClearSeconds: 10 });
  expect(getClipboardClearMs()).toBe(10_000);
  expect(JSON.parse(localStorage.getItem(SECURITY_PREFERENCES_KEY)!)).toEqual(getSecurityPreferences());
  expect(element.textContent).toContain('Windows 剪贴板历史');
  expect(element.textContent).toContain('用于之后的复制');
});

it('keeps the saved value and shows a retryable error when local storage fails', async () => {
  await act(() => root.render(<SecuritySettings browser={false} windows={false} />));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota'); });
  await select('security-lock-label', '5');
  expect(getSecurityPreferences().autoLockMinutes).toBe(15);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('无法保存安全设置');
  expect(element.querySelector('[aria-labelledby="security-lock-label"]')?.textContent).toContain('15 分钟');
});

it('shows the extension runtime limits without offering ineffective controls', async () => {
  await act(() => root.render(<SecuritySettings browser windows={false} />));
  expect(element.querySelector('[role="combobox"]')).toBeNull();
  expect(element.textContent).toContain('浏览器扩展使用固定安全时限');
  expect(element.textContent).toContain('15 分钟');
  expect(element.textContent).toContain('30 秒');
});
