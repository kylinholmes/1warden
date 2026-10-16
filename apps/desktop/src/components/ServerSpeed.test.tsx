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

it('automatically measures latency once after custom address editing settles, including StrictMode', async () => {
  await render(); await advance(300); await render(second); await advance(300);
  expect(probe).not.toHaveBeenCalled();
  probe.mockResolvedValue(result(second)); await advance();
  expect(probe).toHaveBeenCalledExactlyOnceWith(second, expect.objectContaining({ mode: 'latency' }));
  expect(node.textContent).toContain('24 ms'); expect(node.textContent).not.toContain('MB/s');
});
it('keeps both metrics in one flat row and every manual measurement runs a full probe without submitting its form', async () => {
  await render();
  expect(node.textContent).not.toContain('4 MiB');
  expect(node.querySelector('details, summary')).toBeNull();
  const row = node.querySelector('[data-server-speed-metrics]')!;
  expect(row).not.toBeNull(); expect(row.textContent).toContain('延迟');
  expect(row.textContent).toContain('下载'); expect(row.textContent).toContain('未测试');
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const form = document.createElement('form'); form.addEventListener('submit', submitted); node.replaceWith(form); form.append(node);
  probe.mockResolvedValue({ ...result(), download: { bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 } });
  await act(() => button('测速').click());
  expect(submitted).not.toHaveBeenCalled(); expect(probe.mock.calls[0]![1].mode).toBe('full');
  expect(row.textContent).toContain('1.31 MB/s'); expect(row.textContent).toContain('24 ms');
  await act(() => button('测速').click());
  expect(probe.mock.calls.map(call => call[1].mode)).toEqual(['full', 'full']);
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
  await render(); await act(() => button('测速').click());
  expect(node.querySelector('[data-server-speed-metrics]')!.textContent).toContain('测速中…');
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await act(() => button('取消测速').click()); expect(signal.aborted).toBe(true);
  await act(() => complete(result(first, 999)));
  expect(node.textContent).not.toContain('999');
});
it.each(['', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret'])('shows pending input without probing invalid address %s', async url => {
  await render(url); await advance(); expect(button('测速').disabled).toBe(true);
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
  probe.mockResolvedValue(result()); await act(() => button('测速').click());
  expect(probe.mock.calls.at(-1)![1].mode).toBe('full');
  expect(node.textContent).toContain('24 ms');
});
it('full measurement aborts on URL change, busy and unmount', async () => {
  probe.mockImplementation(() => new Promise(() => {}));
  await render(); await act(() => button('测速').click());
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await render(second); expect(signal.aborted).toBe(true);
  await act(() => button('测速').click());
  const next = probe.mock.calls[1]![1].signal as AbortSignal;
  await render(second, true); expect(next.aborted).toBe(true);
  expect(button('测速').disabled).toBe(true);
  await render(second); await act(() => button('测速').click());
  const finalSignal = probe.mock.calls[2]![1].signal as AbortSignal;
  await act(() => root!.unmount()); root = undefined; expect(finalSignal.aborted).toBe(true);
});
it('shows compact unavailable download state and an accessible error without explanatory prose', async () => {
  await render();
  probe.mockResolvedValue({ ...result(first, 82), downloadNote: 'long explanatory resource details should stay out of the form' });
  await act(() => button('测速').click());
  expect(node.querySelector('[data-server-speed-metrics]')!.textContent).toContain('82 ms');
  expect(node.textContent).toContain('暂不可用');
  expect(node.textContent).not.toContain('long explanatory');
  probe.mockRejectedValueOnce(Error('offline'));
  await act(() => button('测速').click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe('测速失败，请重试');
  expect(button('测速').disabled).toBe(false);
});
