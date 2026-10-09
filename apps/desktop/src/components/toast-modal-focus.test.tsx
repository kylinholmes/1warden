// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FloatingPanel } from '@1warden/ui';
import { ToastProvider, useToast } from './Toast';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined; document.body.replaceChildren(); vi.restoreAllMocks();
});
function Notify() {
  const toast = useToast();
  return <button id="notify" onClick={() => toast.show({ tone: 'danger', message: 'Synthetic persistent error' })}>Notify</button>;
}
async function mount() {
  // JSDOM has no layout; expose only the connected, non-hidden focus targets.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.isConnected && !this.closest('[inert],[hidden]') ? document.body : null;
  });
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (children?: ReactNode) => {
    await act(async () => {
      root!.render(<ToastProvider><Notify />{children}</ToastProvider>);
      await Promise.resolve();
    });
  };
  await render();
  await act(() => { document.getElementById('notify')!.focus(); document.getElementById('notify')!.click(); });
  return render;
}
function Panel({ id = 'editor', open = true }: { id?: string; open?: boolean }) {
  return <FloatingPanel open={open} labelledBy={id} onClose={() => {}}>
    <h2 id={id}>{id}</h2><button id={`${id}-first`}>First</button><button id={`${id}-last`}>Last</button>
  </FloatingPanel>;
}
function tab(shiftKey = false) {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
}
it('keeps the same notification inside the active dialog accessibility and Tab scope', async () => {
  const render = await mount();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!;
  await render(<Panel />);
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.contains(close)).toBe(true);
  expect(document.activeElement).toBe(panel);
  await act(() => tab(true));
  expect(document.activeElement).toBe(close);
  await act(() => tab());
  expect(document.activeElement).toBe(document.getElementById('editor-first'));
  expect(document.querySelectorAll('[aria-label="通知"]')).toHaveLength(1);
});
it('returns keyboard focus to the last dialog control when dismissing a notification', async () => {
  const render = await mount();
  await render(<Panel />);
  const last = document.getElementById('editor-last')!;
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!;
  await act(() => { last.focus(); close.focus(); close.click(); });
  expect(document.activeElement).toBe(last);
  expect(close.closest('li')!.hasAttribute('inert')).toBe(true);
});
it('moves a persistent notification through nested dialogs without duplicating or losing it', async () => {
  const render = await mount();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!;
  await render(<><Panel /><Panel id="confirm" /></>);
  expect(close.closest('[role="dialog"]')!.getAttribute('aria-labelledby')).toBe('confirm');
  await render(<><Panel /><Panel id="confirm" open={false} /></>);
  expect(close.closest('[role="dialog"]')!.getAttribute('aria-labelledby')).toBe('editor');
  await render(<Panel open={false} />);
  expect(close.closest('[role="dialog"]')).toBeNull();
  expect(close.isConnected).toBe(true);
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
});
it('restores the notification trigger when no modal is open', async () => {
  await mount();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!;
  await act(() => { close.focus(); close.click(); });
  expect(document.activeElement).toBe(document.getElementById('notify'));
});
