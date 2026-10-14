import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { probeServer, registrationServerUrl, type SiteProbeMode, type SiteProbeResult } from '@1warden/api';
import { host } from './host';
import { IconSpinner } from './icons';

interface ProbeState {
  url: string;
  mode: SiteProbeMode | null;
  result: SiteProbeResult | null;
  error: string | null;
}
const empty = (url: string): ProbeState => ({ url, mode: null, result: null, error: null });

/** Public site measurements stay independent of account authentication. */
export function ServerSpeed({ serverUrl, disabled = false }: { serverUrl: string; disabled?: boolean }) {
  let url = '';
  try { url = registrationServerUrl(serverUrl); } catch { /* Incomplete custom address. */ }
  const store = useLocalStore(() => ({ state: empty(url) }));
  const [state, setState] = useStoreField(store, 'state');
  const request = useRef<{ version: number; controller: AbortController | null; timer: ReturnType<typeof setTimeout> | null }>({
    version: 0, controller: null, timer: null,
  });
  function stop() {
    request.current.version++;
    if (request.current.timer !== null) clearTimeout(request.current.timer);
    request.current.timer = null;
    request.current.controller?.abort();
    request.current.controller = null;
  }
  async function run(mode: SiteProbeMode) {
    stop();
    if (!url || disabled) return;
    const version = request.current.version;
    const controller = new AbortController();
    request.current.controller = controller;
    setState({ ...empty(url), mode });
    try {
      const result = await probeServer(url, { mode, fetchImpl: host().fetch, signal: controller.signal });
      if (version === request.current.version) setState({ ...empty(url), result });
    } catch (error) {
      if (version === request.current.version) setState({ ...empty(url), error: probeMessage(error) });
    } finally {
      if (version === request.current.version) request.current.controller = null;
    }
  }
  useEffect(() => {
    stop();
    setState(empty(url));
    if (url && !disabled) request.current.timer = setTimeout(() => { void run('latency'); }, 650);
    return stop;
  }, [url, disabled]);

  const current = state.url === url ? state : empty(url);
  const { result, error, mode } = current;
  return <div className="rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-xs" data-server-speed>
    <div className="flex items-center justify-between gap-3">
      <div role="status" aria-live="polite" className="min-w-0 text-[var(--ink-secondary)]">
        {mode ? <span className="flex items-center gap-1.5"><IconSpinner size={12} />{mode === 'full' ? '正在测速…' : '正在测量延迟…'}</span>
          : result ? <span>延迟 <strong className="font-medium tabular-nums">{result.latencyMs < 1 ? '<1' : Math.round(result.latencyMs)} ms</strong>
            {result.samples < 3 && <span className="ml-1 text-[var(--ink-tertiary)]">（{result.samples}/3 次成功）</span>}</span>
          : error ? <span>{error}</span>
          : <span>{!url ? '填写有效地址后测量延迟' : disabled ? '站点测速' : '等待测量延迟…'}</span>}
      </div>
      <button type="button" disabled={disabled || !url} className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
        onClick={() => {
          if (mode === 'full') { stop(); setState({ ...empty(url), error: '已取消测速' }); }
          else void run('full');
        }}>{mode === 'full' ? '取消测速' : '测速'}</button>
    </div>
    {result?.download && <p className="mt-1.5 text-[var(--ink-secondary)]">下载参考 <strong className="font-medium tabular-nums">{(result.download.bytesPerSecond / 1_000_000).toFixed(2)} MB/s</strong></p>}
    {result?.downloadNote && <p className="mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">{result.downloadNote}</p>}
    <p className="mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">点击测速会下载少量公开资源（最多约 4 MiB），下载速度仅供参考。</p>
  </div>;
}

function probeMessage(error: unknown): string {
  switch ((error as { kind?: string } | null)?.kind) {
    case 'certUntrusted': return '服务器证书无法验证，请先确认站点证书后重试';
    case 'auth': return '站点限制匿名测速';
    case 'rateLimited': return '测速过于频繁，请稍后再试';
    case 'timeout': return '测速超时，可稍后重试';
    case 'network': return '连不上服务器，请检查地址与网络';
    default: return '暂时无法测速，请检查地址或网络后重试';
  }
}
