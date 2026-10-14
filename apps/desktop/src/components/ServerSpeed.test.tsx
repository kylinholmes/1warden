// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerSpeed } from '../../../../packages/ui/src/ServerSpeed';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@1warden/api', async original => ({ ...await original<object>(), probeServer: probe }));
vi.mock('../../../../packages/ui/src/host', () => ({ host: () => ({ fetch: globalThis.fetch }) }));
let node: HTMLDivElement;
let root: Root | undefined;
const first = 'https://first.example';
const second = 'https://second.example';
const result = (serverUrl = first, latencyMs = 24) => ({ serverUrl, latencyMs, samples: 3, download: null, downloadNote: null });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers(); probe.mockReset(); probe.mockResolvedValue(result());
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { if (root) await act(() => root!.unmount()); node.remove(); vi.useRealTimers(); });
async function render(serverUrl = first, disabled = false) {
  await act(() => root!.render(createElement(StrictMode, null, createElement(ServerSpeed, { serverUrl, disabled }))));
}
async function advance(ms = 700) { await act(() => vi.advanceTimersByTimeAsync(ms)); }
const button = () => node.querySelector<HTMLButtonElement>('button')!;

it('automatically measures latency once after address editing settles, including StrictMode', async () => {
  await render(); await advance(300); await render(second); await advance(300);
  expect(probe).not.toHaveBeenCalled();
  probe.mockResolvedValue(result(second)); await advance();
  expect(probe).toHaveBeenCalledExactlyOnceWith(second, expect.objectContaining({ mode: 'latency' }));
  expect(node.textContent).toContain('24 ms'); expect(node.textContent).not.toContain('MB/s');
});

it('manual full measurement replaces pending auto work and never submits a login form', async () => {
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const form = document.createElement('form'); form.addEventListener('submit', submitted); node.replaceWith(form); form.append(node);
  probe.mockResolvedValue({ ...result(), download: { bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 } });
  await render(); await act(() => button().click()); await advance();
  expect(submitted).not.toHaveBeenCalled(); expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]![1].mode).toBe('full');
  expect(node.textContent).toContain('1.31 MB/s'); expect(node.textContent).toContain('下载参考');
  form.replaceWith(node);
});

it('switching sites aborts the old request and ignores a late result', async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  probe.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render(); await advance();
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await render(second); expect(signal.aborted).toBe(true);
  probe.mockResolvedValue(result(second, 51)); await advance();
  await act(() => complete(result(first, 999)));
  expect(node.textContent).toContain('51 ms'); expect(node.textContent).not.toContain('999');
});

it('cancel discards an in-flight full result without immediately starting again', async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  probe.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await render(); await act(() => button().click());
  expect(button().textContent).toContain('取消');
  const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await act(() => button().click()); expect(signal.aborted).toBe(true);
  await act(() => complete(result(first, 999))); await advance(2000);
  expect(node.textContent).not.toContain('999'); expect(probe).toHaveBeenCalledTimes(1);
});

it('login activity and unmount stop probe work', async () => {
  probe.mockImplementation(() => new Promise(() => {}));
  await render(); await advance(); const signal = probe.mock.calls[0]![1].signal as AbortSignal;
  await render(first, true); expect(signal.aborted).toBe(true); expect(button().disabled).toBe(true);
  await advance(2000); expect(probe).toHaveBeenCalledTimes(1);
  await render(); await advance(); const next = probe.mock.calls[1]![1].signal as AbortSignal;
  await act(() => root!.unmount()); root = undefined;
  expect(next.aborted).toBe(true);
});

it.each(['', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret'])('does not probe invalid address %s', async url => {
  await render(url); await advance(); expect(button().disabled).toBe(true); expect(probe).not.toHaveBeenCalled();
});

it('explains unavailable throughput while preserving latency', async () => {
  probe.mockResolvedValue({ ...result(), downloadNote: '公开资源样本太小，暂无法测量下载速度' });
  await render(); await act(() => button().click());
  expect(node.textContent).toContain('24 ms'); expect(node.textContent).toContain('暂无法测量');
  expect(node.textContent).not.toContain('MB/s');
});

it('displays anonymous access failures without suggesting the account password is wrong', async () => {
  probe.mockRejectedValue({ kind: 'auth' }); await render(); await advance();
  expect(node.textContent).toContain('匿名测速'); expect(node.textContent).not.toContain('主密码');
  expect(node.querySelector('[role="alert"]')).toBeNull(); expect(button().disabled).toBe(false);
});
