// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Quick } from './Quick';
const harness = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: any }) => void>(), requests: [] as any[], queries: [] as any[], cancel: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  if (command === 'quick_window_state') return { generation: 1, pinned: false };
  if (command === 'quick_auth_request') harness.requests.push(args.request);
  if (command === 'quick_auth_cancel') harness.cancel();
} }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, listener: any) => { harness.listeners.set(event, listener); return () => harness.listeners.delete(event); },
  emitTo: async (_window: string, event: string, payload: any) => { if (event === '1warden:query') harness.queries.push(payload); },
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
let root: Root; let node: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(() => root.unmount()); node.remove(); harness.listeners.clear(); harness.requests.length = 0; harness.queries.length = 0; harness.cancel.mockClear(); vi.useRealTimers(); });
async function event(name: string, payload: unknown) { await act(() => harness.listeners.get(name)!({ payload })); }
it.each([false, true])('retains timeout feedback after native cancellation (mailbox expiry %s)', async expired => {
  vi.useFakeTimers();
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(() => root.render(createElement(Quick)));
  const account = { id: 'synthetic', email: 'synthetic@example.test', serverUrl: 'https://vault.example.test', displayName: '', avatarDataUrl: null };
  await event('1warden:results', { seq: harness.queries.at(-1).seq, locked: true, items: [], accounts: [account], serverUrl: null });
  if (!expired) await act(() => vi.advanceTimersByTimeAsync(60_000));
  const request = harness.requests.at(-1);
  await event('1warden:quick-auth-cancelled', { generation: request.generation, requestId: request.requestId, unlocked: false, expired });
  expect(node.querySelector('[role=alert]')?.textContent).toContain('超时');
  expect(document.activeElement).toBe(node.querySelector('input[type=password]'));
});
it('waits for accepted authentication even when the search bridge reports unlocked first', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(() => root.render(createElement(Quick)));
  const account = { id: 'synthetic', email: 'synthetic@example.test', serverUrl: 'https://vault.example.test', displayName: '', avatarDataUrl: null };
  const seq = harness.queries.at(-1).seq;
  await event('1warden:results', { seq, locked: true, items: [], accounts: [account], accountsLoading: false, serverUrl: null });
  await event('1warden:quick-auth-result', { ...harness.requests.at(-1), stage: 'password' });
  const input = node.querySelector<HTMLInputElement>('input[type=password]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'synthetic-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  harness.cancel.mockClear();
  await event('1warden:results', { seq, locked: false, items: [], accounts: [account], serverUrl: null });
  expect(node.querySelector('input[type=password]')).not.toBeNull();
  expect(harness.cancel).not.toHaveBeenCalled();
  await event('1warden:quick-auth-result', { ...harness.requests.at(-1), stage: 'unlocked' });
  expect(node.querySelector('input[type=password]')).toBeNull();
  expect(document.activeElement).toBe(node.querySelector('[aria-label="搜索保险库"]'));
});
