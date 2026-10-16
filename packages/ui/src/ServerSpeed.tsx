import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { type SiteProbeResult } from '@1warden/api';
import { normalizeServerUrl, useServerLatencies, type LatencyState } from './server-latency';

/** Color is supplementary: every light has readable latency or connection text. */
export function ServerLatencyStatus({ state, valid = true }: { state: LatencyState; valid?: boolean }) {
  const color = state.status === 'error' ? 'red' : state.status !== 'ready' ? 'grey'
    : state.latencyMs <= 300 ? 'green' : state.latencyMs <= 1000 ? 'amber' : 'red';
  const text = !valid ? '待输入' : state.status === 'measuring' ? '测量中…' : state.status === 'error' ? '未连通'
    : state.status === 'ready' ? `${state.latencyMs < 1 ? '<1' : Math.round(state.latencyMs)} ms` : '待测量';
  const backgrounds = { green: '#22a06b', amber: '#d99000', red: '#d84b4b', grey: 'var(--ink-tertiary)' };
  return <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--ink-secondary)]" role="status">
    <span aria-hidden="true" data-latency-light={color} className="h-1.5 w-1.5 rounded-full" style={{ background: backgrounds[color] }} />
    <span className="tabular-nums">{text}</span>
  </span>;
}

/** Shared automatic latency, with one explicit action for a full measurement. */
export function ServerSpeed({ serverUrl, disabled = false }: { serverUrl: string; disabled?: boolean }) {
  const url = normalizeServerUrl(serverUrl);
  const latency = useServerLatencies([url], 650, disabled);
  const store = useLocalStore(() => ({
    full: { url, busy: false } as { url: string; busy: boolean; result?: SiteProbeResult; error?: string } }));
  const [full, setFull] = useStoreField(store, 'full');
  const request = useRef<{ version: number; controller: AbortController | null }>({ version: 0, controller: null });
  function stop() { request.current.version++; request.current.controller?.abort(); request.current.controller = null; }
  useEffect(() => {
    stop(); setFull({ url, busy: false });
    return stop;
  }, [url, disabled]);
  async function measure() {
    stop();
    if (!url || disabled) return;
    const version = request.current.version;
    const controller = new AbortController(); request.current.controller = controller;
    setFull({ url, busy: true });
    try {
      const result = await latency.measureFull(url, controller.signal);
      if (version === request.current.version) setFull({ url, busy: false, result });
    } catch {
      if (version === request.current.version) setFull({ url, busy: false, error: '测速失败，请重试' });
    } finally { if (version === request.current.version) request.current.controller = null; }
  }
  const current = full.url === url ? full : { url, busy: false };
  const shownLatency = latency.get(url);
  const download = current.busy ? '测速中…' : current.result?.download
    ? `${(current.result.download.bytesPerSecond / 1_000_000).toFixed(2)} MB/s`
    : current.result ? '暂不可用' : '未测试';
  return <div className="space-y-1 text-xs" data-server-speed>
    <p className="truncate text-[var(--ink-tertiary)]" title={url}>{url || '服务器地址'}</p>
    <div data-server-speed-metrics className="flex items-center gap-2 whitespace-nowrap text-[var(--ink-tertiary)]">
      <span>延迟</span>
      <ServerLatencyStatus state={shownLatency} valid={Boolean(url)} />
      <span aria-hidden="true">·</span>
      <span className="inline-flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        下载 <span className="truncate tabular-nums text-[var(--ink-secondary)]">{download}</span>
      </span>
      <button type="button" disabled={disabled || !url} className="btn btn-ghost ml-auto shrink-0 px-1.5 py-1 text-xs"
        onClick={() => { if (current.busy) { stop(); setFull({ url, busy: false, error: '已取消测速' }); } else void measure(); }}>
        {current.busy ? '取消测速' : '测速'}
      </button>
    </div>
    {current.error && <p role={current.error === '已取消测速' ? 'status' : 'alert'} className="text-xs text-[var(--ink-secondary)]">{current.error}</p>}
  </div>;
}
