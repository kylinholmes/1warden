// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerSpeed } from '../../../../packages/ui/src/ServerSpeed';
import { installHost, resetHost } from '../../../../packages/ui/src/host';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@1warden/api', async original => ({ ...await original<object>(), probeServer: probe }));
let node: HTMLDivElement;
let root: Root | undefined;
const first = 'https://first.example';
const second = 'https://second.example';
const result = (serverUrl = first, latencyMs = 24) => ({ serverUrl, latencyMs, samples: 3, download: null, downloadNote: null });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers(); probe.mockReset(); probe.mockResolvedValue(result());
  installHost({ fetch: vi.fn() as typeof fetch, storage: { get: async () => null, set: async () => {}, remove: async () => {} } });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { if (root) await act(() => root!.unmount()); node.remove(); resetHost(); vi.useRealTimers(); });
async function render(serverUrl = first, disabled = false) {
  await act(() => root!.render(createElement(StrictMode, null, createElement(ServerSpeed, { serverUrl, disabled }))));
}
async function advance(ms = 700) { await act(() => vi.advanceTimersByTimeAsync(ms)); }
const button = (text: string) => [...node.querySelectorAll('button')].find(item => item.textContent === text)!;
async function expand() { await act(() => node.querySelector('summary')!.click()); }

it('automatically measures latency once after custom address editing settles, including StrictMode', async () => {
  await render(); await advance(300); await render(second); await advance(300);
  expect(probe).not.toHaveBeenCalled();
  probe.mockResolvedValue(result(second)); await advance();
  expect(probe).toHaveBeenCalledExactlyOnceWith(second, expect.objectContaining({ mode: 'latency' }));
  expect(node.textContent).toContain('24 ms'); expect(node.textContent).not.toContain('MB/s');
});
it('keeps download instructions and full measurement inside an optional disclosure', async () => {
  await render();
  expect(node.textContent).not.toContain('4 MiB');
  expect(node.querySelector('summary')?.textContent).toBe('测速详情');
  await expand(); expect(node.textContent).toContain('4 MiB');
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const form = document.createElement('form'); form.addEventListener('submit', submitted); node.replaceWith(form); form.append(node);
  probe.mockResolvedValue({ ...result(), download: { bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 } });
  await act(() => button('测量下载速度').click());
  expect(submitted).not.toHaveBeenCalled(); expect(probe.mock.calls[0]![1].mode).toBe('full');
  expect(node.textContent).toContain('1.31 MB/s');
  form.replaceWith(node);
});
it('shares in-flight latency across route remounts and ignores another server result', async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  probe.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render(); await advance();
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await render(second); expect(signal.aborted).toBe(false);
  probe.mockResolvedValue(result(second, 51)); await advance();
  await act(() => complete(result(first, 999)));
  expect(node.textContent).toContain('51 ms'); expect(node.textContent).not.toContain('999');
  await render(first); expect(node.textContent).toContain('999 ms');
  await advance(); expect(probe).toHaveBeenCalledTimes(2);
});
it('cancel discards an in-flight full result', async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  probe.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await render(); await expand(); await act(() => button('测量下载速度').click());
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await act(() => button('取消测速').click()); expect(signal.aborted).toBe(true);
  await act(() => complete(result(first, 999)));
  expect(node.textContent).not.toContain('999');
});
it.each(['', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret'])('shows pending input without probing invalid address %s', async url => {
  await render(url); await advance(); expect(button('重测').disabled).toBe(true);
  expect(node.textContent).toContain('待输入'); expect(probe).not.toHaveBeenCalled();
});
it.each([[120, 'green'], [300, 'green'], [301, 'amber'], [1000, 'amber'], [1001, 'red']] as const)('shows readable latency %s with %s status', async (latency, color) => {
  probe.mockResolvedValue(result(first, latency)); await render(); await advance();
  expect(node.textContent).toContain(`${latency} ms`);
  expect(node.querySelector('[data-latency-light]')?.getAttribute('data-latency-light')).toBe(color);
  expect(node.textContent).not.toContain('未连通');
});
it('distinguishes failures from slow responses and lets the user retry', async () => {
  probe.mockRejectedValueOnce(new Error('offline')); await render(); await advance();
  expect(node.textContent).toContain('未连通');
  expect(node.querySelector('[data-latency-light]')?.getAttribute('data-latency-light')).toBe('red');
  probe.mockResolvedValue(result()); await act(() => button('重测').click());
  expect(node.textContent).toContain('24 ms');
});
it('full measurement aborts on URL change, busy and unmount', async () => {
  probe.mockImplementation(() => new Promise(() => {}));
  await render(); await expand(); await act(() => button('测量下载速度').click());
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await render(second); expect(signal.aborted).toBe(true);
  await act(() => button('测量下载速度').click());
  const next = probe.mock.calls[1]![1].signal as AbortSignal;
  await render(second, true); expect(next.aborted).toBe(true);
  expect(button('重测').disabled).toBe(true);
  await render(second); await act(() => button('测量下载速度').click());
  const finalSignal = probe.mock.calls[2]![1].signal as AbortSignal;
  await act(() => root!.unmount()); root = undefined; expect(finalSignal.aborted).toBe(true);
});
