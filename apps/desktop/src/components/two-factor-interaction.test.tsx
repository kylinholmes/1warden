// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TwoFactorForm } from '@1warden/ui';
let root: Root; let host: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); });
async function mount(providers: number[]) {
  const onSubmit = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(createElement(TwoFactorForm, { providers, busy: false, onSubmit })));
  return onSubmit;
}
it('uses a supported authenticator even when the first advertised method is a security key', async () => {
  const onSubmit = await mount([7, 0]);
  const input = host.querySelector<HTMLInputElement>('[aria-label="验证码"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ code: '123456', provider: 0, remember: false });
  expect(host.textContent).not.toContain('记住这台设备');
});
it('explains unsupported-only methods without offering a nonfunctional code submission', async () => {
  await mount([7]);
  expect(host.querySelector('[role=alert]')?.textContent).toContain('当前客户端暂不支持');
  expect(host.querySelector('form')).toBeNull();
});
