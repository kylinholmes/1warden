// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';
import { SyncNotice } from './SyncNotice';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(child: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(child));
}
function Announce() {
  const toast = useToast();
  return createElement('button', { onClick: () => toast.show({ tone: 'success', message: 'Saved fixture', duration: Infinity }) }, 'notify');
}
it('moves notifications above an active footer and releases the clearance after closing', async () => {
  const layer = document.createElement('div'); layer.className = 'floating-layer'; layer.dataset.open = 'true';
  const panel = document.createElement('div'); panel.className = 'panel'; layer.append(panel);
  const footer = document.createElement('div'); footer.className = 'panel-foot'; panel.append(footer); document.body.append(layer);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === footer) return new DOMRect(0, window.innerHeight - 44, window.innerWidth, 44);
    if (this.getAttribute('aria-label') === '通知') return new DOMRect(window.innerWidth - 356, window.innerHeight - 66, 340, 50);
    return new DOMRect();
  });
  await mount(createElement(ToastProvider, null, createElement(Announce)));
  await act(() => host.querySelector('button')!.click());
  const region = document.querySelector<HTMLElement>('[aria-label="通知"]')!;
  expect(region.style.bottom).toBe('56px');
  const nestedLayer = document.createElement('div'); nestedLayer.className = 'floating-layer'; nestedLayer.dataset.open = 'true';
  const nestedPanel = document.createElement('div'); nestedPanel.className = 'panel'; nestedLayer.append(nestedPanel);
  await act(async () => { document.body.append(nestedLayer); await Promise.resolve(); });
  expect(region.style.bottom).toBe('16px');
  expect(nestedPanel.contains(region)).toBe(true);
  await act(async () => { nestedLayer.remove(); await Promise.resolve(); });
  expect(region.style.bottom).toBe('56px');
  await act(async () => { layer.dataset.open = 'false'; await Promise.resolve(); });
  expect(region.style.bottom).toBe('16px');
});
it('distinguishes unavailable vault data and allows a failed sync to be retried', async () => {
  const sync = vi.fn().mockRejectedValue(new Error('Synthetic offline'));
  const client = { sync } as unknown as ApplicationClient;
  const session = { ...EMPTY_SNAPSHOT, syncError: '同步失败，请检查网络', status: 'unlocked' as const };
  await mount(createElement(SyncNotice, { session, client }));
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('尚不能确认保险库内容');
  await act(() => host.querySelector('button')!.click());
  expect(sync).toHaveBeenCalledTimes(1);
  await act(() => root!.render(createElement(SyncNotice, { session: { ...session, syncing: true }, client })));
  expect(host.querySelector('button')!.disabled).toBe(true);
  await act(() => root!.render(createElement(SyncNotice, { session: { ...session, syncError: null }, client })));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
