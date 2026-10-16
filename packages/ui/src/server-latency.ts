import { useEffect } from 'react';
import { useStoreSnapshot } from '@1warden/state/react';
import { probeServer, registrationServerUrl, type SiteProbeResult } from '@1warden/api';
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
          active--; if (entries.get(url) === entry) notify(); drain(); finish();
        });
      });
      drain();
      return pending;
    },
    /** An explicit retry supersedes welcome's cache and any older automatic probe. */
    async measureFull(value: string, signal: AbortSignal): Promise<SiteProbeResult> {
      const url = normalizeServerUrl(value);
      if (!url) throw new Error('服务器地址无效');
      if (signal.aborted) throw new DOMException('测速已取消', 'AbortError');
      const previous = entries.get(url);
      // Cancellation can restore a settled result, never an orphaned measuring state.
      const fallback = previous && !previous.pending ? previous : undefined;
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const entry = { state: { status: 'measuring' } as LatencyState, at: 0, pending: pending as Promise<void> | undefined };
      const cancel = () => {
        if (entries.get(url) === entry) {
          if (fallback) entries.set(url, fallback); else entries.delete(url);
          notify();
        }
        finish();
      };
      entries.set(url, entry);
      signal.addEventListener('abort', cancel, { once: true });
      notify();
      try {
        const result = await probeServer(url, { mode: 'full', fetchImpl, signal });
        if (!signal.aborted) entry.state = { status: 'ready', latencyMs: result.latencyMs };
        return result;
      } catch (error) {
        if (!signal.aborted) entry.state = { status: 'error' };
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        entry.at = Date.now(); entry.pending = undefined;
        if (entries.get(url) === entry) notify();
        finish();
      }
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
