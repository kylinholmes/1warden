import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { probeServer, type SiteProbeResult } from '@1warden/api';
import { host } from './host';
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

/** Compact public latency summary. Download measurement is an explicit detail action. */
export function ServerSpeed({ serverUrl, disabled = false }: { serverUrl: string; disabled?: boolean }) {
  const url = normalizeServerUrl(serverUrl);
  const latency = useServerLatencies([url], 650, disabled);
  const store = useLocalStore(() => ({ expanded: false,
    full: { url, busy: false } as { url: string; busy: boolean; result?: SiteProbeResult; error?: string } }));
  const [expanded, setExpanded] = useStoreField(store, 'expanded');
  const [full, setFull] = useStoreField(store, 'full');
  const request = useRef<{ version: number; controller: AbortController | null }>({ version: 0, controller: null });
  function stop() { request.current.version++; request.current.controller?.abort(); request.current.controller = null; }
  useEffect(() => {
    stop(); setFull({ url, busy: false });
    return stop;
  }, [url, disabled]);
  async function measureDownload() {
    stop();
    if (!url || disabled) return;
    const version = request.current.version;
    const controller = new AbortController(); request.current.controller = controller;
    setFull({ url, busy: true });
    try {
      const result = await probeServer(url, { mode: 'full', fetchImpl: host().fetch, signal: controller.signal });
      if (version === request.current.version) setFull({ url, busy: false, result });
    } catch {
      if (version === request.current.version) setFull({ url, busy: false, error: '暂时无法测速，请检查地址或网络后重试' });
    } finally { if (version === request.current.version) request.current.controller = null; }
  }
  const current = full.url === url ? full : { url, busy: false };
  return <div className="space-y-1 text-xs" data-server-speed>
    <div className="flex items-center gap-2 text-[var(--ink-tertiary)]">
      <span className="min-w-0 flex-1 truncate" title={url}>{url || '服务器地址'}</span>
      <ServerLatencyStatus state={latency.get(url)} valid={Boolean(url)} />
      <button type="button" disabled={disabled || !url || latency.get(url).status === 'measuring'} className="btn btn-ghost shrink-0 px-1.5 py-1 text-xs"
        onClick={() => { void latency.measure(url, true); }}>重测</button>
    </div>
    <details open={expanded}>
      <summary className="cursor-pointer py-1 text-[var(--ink-tertiary)]" onClick={event => { event.preventDefault(); setExpanded(!expanded); }}>测速详情</summary>
      {expanded && <div className="space-y-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5">
        <button type="button" disabled={disabled || !url} className="btn btn-ghost px-2 py-1 text-xs"
          onClick={() => { if (current.busy) { stop(); setFull({ url, busy: false, error: '已取消测速' }); } else void measureDownload(); }}>
          {current.busy ? '取消测速' : '测量下载速度'}</button>
        <div role="status" aria-live="polite">
          {current.busy ? '正在测速…' : current.error}
          {current.result && <p>延迟 {Math.round(current.result.latencyMs)} ms</p>}
          {current.result?.download && <p>下载参考 <strong className="font-medium tabular-nums">{(current.result.download.bytesPerSecond / 1_000_000).toFixed(2)} MB/s</strong></p>}
          {current.result?.downloadNote && <p>{current.result.downloadNote}</p>}
        </div>
        <p className="leading-relaxed text-[var(--ink-tertiary)]">下载测速会读取少量公开资源（最多约 4 MiB），下载速度仅供参考。自动测量只检测延迟。</p>
      </div>}
    </details>
  </div>;
}
