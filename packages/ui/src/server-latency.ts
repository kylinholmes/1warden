import { useEffect } from 'react';
import { useStoreSnapshot } from '@1warden/state/react';
import { probeServer, registrationServerUrl } from '@1warden/api';
import { host } from './host';

export type LatencyState = { status: 'idle' | 'measuring' | 'error'; latencyMs?: never }
  | { status: 'ready'; latencyMs: number };
const idle: LatencyState = { status: 'idle' };
const TTL = 5 * 60_000;
export function normalizeServerUrl(value: string): string {
  try { return registrationServerUrl(value); } catch { return ''; }
}

/** One public probe queue per host transport. Route changes never cancel shared work. */
function createService(fetchImpl: typeof fetch) {
  const entries = new Map<string, { state: LatencyState; at: number; pending: Promise<void> | undefined }>();
  const listeners = new Set<() => void>();
  const queue: (() => void)[] = [];
  let active = 0;
  let revision = 0;
  const notify = () => { revision++; listeners.forEach(listener => listener()); };
  const drain = () => { while (active < 3 && queue.length) queue.shift()!(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    get(value: string): LatencyState { return entries.get(normalizeServerUrl(value))?.state ?? idle; },
    measure(value: string, force = false): Promise<void> {
      const url = normalizeServerUrl(value);
      if (!url) return Promise.resolve();
      const existing = entries.get(url);
      if (existing?.pending) return existing.pending;
      if (existing && !force && Date.now() - existing.at < TTL) return Promise.resolve();
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const entry = { state: { status: 'measuring' } as LatencyState, at: 0, pending: pending as Promise<void> | undefined };
      entries.set(url, entry);
      notify();
      queue.push(() => {
        active++;
        const controller = new AbortController();
        void probeServer(url, { mode: 'latency', fetchImpl, signal: controller.signal }).then(result => {
          entry.state = { status: 'ready', latencyMs: result.latencyMs };
        }, () => { entry.state = { status: 'error' }; }).finally(() => {
          entry.at = Date.now(); entry.pending = undefined;
          active--; notify(); drain(); finish();
        });
      });
      drain();
      return pending;
    },
  };
}
const services = new WeakMap<typeof fetch, ReturnType<typeof createService>>();
export function serverLatency(fetchImpl = host().fetch) {
  let service = services.get(fetchImpl);
  if (!service) { service = createService(fetchImpl); services.set(fetchImpl, service); }
  return service;
}

/** Reuses welcome's completed or in-flight measurements; custom editing is debounced. */
export function useServerLatencies(values: readonly string[], delay = 0, disabled = false) {
  const service = serverLatency();
  useStoreSnapshot(service.subscribe, service.snapshot, service.snapshot);
  const urls = JSON.stringify([...new Set(values.map(normalizeServerUrl).filter(Boolean))]);
  useEffect(() => {
    if (disabled) return;
    const measure = () => { for (const url of JSON.parse(urls) as string[]) void service.measure(url); };
    if (!delay) { measure(); return; }
    const timer = setTimeout(measure, delay);
    return () => clearTimeout(timer);
  }, [service, urls, delay, disabled]);
  return service;
}
