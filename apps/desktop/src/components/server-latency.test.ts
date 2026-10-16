import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { serverLatency } from '../../../../packages/ui/src/server-latency';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@1warden/api', async original => ({ ...await original<object>(), probeServer: probe }));
const result = (serverUrl: string, latencyMs = 42) => ({ serverUrl, latencyMs, samples: 3, download: null, downloadNote: null });
beforeEach(() => { vi.useFakeTimers(); probe.mockReset(); probe.mockImplementation(async url => result(url)); });
afterEach(() => vi.useRealTimers());
it('normalizes aliases, shares in-flight probes and keeps fresh results for five minutes', async () => {
  const service = serverLatency(vi.fn() as typeof fetch);
  await Promise.all([service.measure('https://EXAMPLE.com:443/team/'), service.measure('https://example.com/team')]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(service.get('https://example.com/team')).toMatchObject({ status: 'ready', latencyMs: 42 });
  await service.measure('https://example.com/team'); expect(probe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_000);
  await service.measure('https://example.com/team'); expect(probe).toHaveBeenCalledTimes(2);
  await service.measure('https://example.com/other'); expect(probe).toHaveBeenCalledTimes(3);
});
it('bounds concurrency to three and keeps queued requests deduplicated', async () => {
  const complete: (() => void)[] = [];
  probe.mockImplementation(url => new Promise(resolve => complete.push(() => resolve(result(url)))));
  const service = serverLatency(vi.fn() as typeof fetch);
  const requests = Array.from({ length: 5 }, (_, index) => service.measure(`https://s${index}.example`));
  const duplicate = service.measure('https://s4.example/');
  expect(probe).toHaveBeenCalledTimes(3);
  expect(service.get('https://s4.example').status).toBe('measuring');
  complete[0]!(); await requests[0]; expect(probe).toHaveBeenCalledTimes(4);
  complete[1]!(); await requests[1]; expect(probe).toHaveBeenCalledTimes(5);
  complete.slice(2).forEach(resolve => resolve()); await Promise.all([...requests, duplicate]);
  expect(probe).toHaveBeenCalledTimes(5);
});
it('caches errors, allows explicit retries, and isolates host fetch instances', async () => {
  const first = serverLatency(vi.fn() as typeof fetch);
  probe.mockRejectedValueOnce(new Error('offline'));
  await first.measure('https://example.com');
  expect(first.get('https://example.com').status).toBe('error');
  await first.measure('https://example.com'); expect(probe).toHaveBeenCalledTimes(1);
  await first.measure('https://example.com', true);
  expect(first.get('https://example.com').status).toBe('ready');
  const next = serverLatency(vi.fn() as typeof fetch);
  expect(next.get('https://example.com').status).toBe('idle');
  await next.measure('https://example.com'); expect(probe).toHaveBeenCalledTimes(3);
});
it.each(['', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret'])('does not probe invalid public address %s', async url => {
  const service = serverLatency(vi.fn() as typeof fetch);
  await service.measure(url); expect(probe).not.toHaveBeenCalled();
});
