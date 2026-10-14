import { registrationServerUrl } from './registration';
import { serverEnvironment } from './server-environment';
import { ApiError, classifyStatus, isApiErrorKind } from './errors';

export type SiteProbeMode = 'latency' | 'full';
export interface SiteProbeResult {
  serverUrl: string;
  latencyMs: number;
  samples: number;
  download: { bytes: number; durationMs: number; bytesPerSecond: number } | null;
  downloadNote: string | null;
}

interface ProbeOptions {
  mode: SiteProbeMode;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}
interface Budget { remaining: number }
interface PublicResponse { body: Uint8Array; headers: Headers; durationMs: number; status: number; type: ResponseType }
const CONFIG_BYTES = 64 * 1024;
const TOTAL_BYTES = 4 * 1024 * 1024;
let requestSequence = 0;

function abortError(): DOMException { return new DOMException('测速已取消', 'AbortError'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function declaredBytes(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation itself can hang on a custom stream. It must not delay a deadline.
  void body?.cancel().catch(() => {});
}

/** Independent deadlines also protect hosts whose fetch implementation ignores AbortSignal.
 * Native hosts consume the extra bounds before buffering; browsers use the stream bounds below.
 * Failed requests reserve their entire byte allowance because a native error cannot report
 * how much of the response was already received. This keeps the overall budget conservative. */
async function publicRequest(url: URL, options: ProbeOptions, budget: Budget,
  maxBytes: number, timeoutMs: number, accept: string): Promise<PublicResponse> {
  checkAbort(options.signal);
  const cap = Math.min(maxBytes, budget.remaining);
  if (cap <= 0) throw new Error('测速流量额度已用完');
  url.search = '';
  url.hash = '';
  url.searchParams.set('_1warden_probe', `${Date.now()}-${++requestSequence}`);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  let charged = 0;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectDeadline(error);
  };
  const onAbort = () => stop(abortError());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop(new ApiError('timeout', '服务器响应超时')), timeoutMs);
  const started = performance.now();
  try {
    const request = async (): Promise<PublicResponse> => {
      const init: RequestInit & { timeoutMs: number; maxResponseBytes: number } = {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Accept: accept }, signal: controller.signal, timeoutMs, maxResponseBytes: cap,
      };
      const response = await options.fetchImpl(url.href, init);
      if (stopped || controller.signal.aborted) { cancelBody(response.body); throw abortError(); }
      if (!response.ok) {
        cancelBody(response.body);
        throw new ApiError(classifyStatus(response.status), '服务器拒绝了公开测速请求', { status: response.status });
      }
      if (response.redirected) {
        cancelBody(response.body);
        throw new Error('测速资源发生重定向');
      }
      if (response.url && new URL(response.url).href !== url.href) {
        cancelBody(response.body);
        throw new Error('测速资源发生重定向');
      }
      const contentLength = declaredBytes(response.headers);
      if (contentLength !== null && contentLength > cap) { cancelBody(response.body); throw new Error('测速响应超过大小限制'); }
      const chunks: Uint8Array[] = [];
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (stopped || controller.signal.aborted) throw abortError();
          if (chunk.done) break;
          const length = chunk.value.byteLength;
          if (charged + length > cap) {
            budget.remaining -= cap - charged;
            charged = cap;
            void reader.cancel().catch(() => {});
            throw new Error('测速响应超过大小限制');
          }
          charged += length;
          budget.remaining -= length;
          chunks.push(chunk.value);
        }
      }
      const body = new Uint8Array(charged);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      // A compressed response may occasionally be larger on the wire than when decoded.
      // Charge the larger representation, while still bounding both independently.
      if (contentLength !== null && contentLength > charged) {
        budget.remaining -= contentLength - charged;
        charged = contentLength;
      }
      return { body, headers: response.headers, status: response.status, type: response.type, durationMs: Math.max(0, performance.now() - started) };
    };
    return await Promise.race([request(), deadline]);
  } catch (error) {
    budget.remaining -= cap - charged;
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function validConfig(body: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器配置格式无效');
  const config = value as Record<string, unknown>;
  const server = config.server as Record<string, unknown> | undefined;
  if (config.object !== 'config' || !(
    typeof config.version === 'string' && config.version.trim() ||
    server && typeof server.name === 'string' && server.name.trim()
  )) throw new Error('服务器配置格式无效');
  return config;
}

function assetCandidates(html: string, base: string): URL[] {
  const home = new URL(`${base}/`);
  const candidates: URL[] = [];
  const seen = new Set<string>();
  // Inspect inert text only. Never attach remote markup or execute scripts, and ignore
  // <base> so a page cannot change the selected server's origin or installation path.
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link)\b([^>]*)>/gi);
  for (const tag of tags) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[2]!.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = attribute[1]!.toLowerCase();
      if (!attributes.has(name)) attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    const script = tag[1]!.toLowerCase() === 'script';
    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (!script && !rel.includes('stylesheet') && !rel.includes('modulepreload')) continue;
    const source = attributes.get(script ? 'src' : 'href');
    if (!source) continue;
    try {
      const url = new URL(source.replace(/&amp;/gi, '&'), home);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== home.origin || url.username || url.password || !/\.(?:js|css)$/i.test(url.pathname)) continue;
      // Exclude API/auth routes even when they masquerade as a static filename.
      const path = decodeURIComponent(url.pathname).replace(/\\/g, '/');
      if (path.includes('%') || /(?:^|\/)(?:api|identity|accounts?|auth|login|logout|connect|token|ciphers|sync|notifications|sends)(?:\/|$)/i.test(path)) continue;
      url.search = '';
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      candidates.push(url);
      if (candidates.length === 2) break;
    } catch { /* Malformed or non-HTTP asset references are not candidates. */ }
  }
  return candidates;
}

function staticPayloadBytes(response: PublicResponse): number | null {
  if (response.status !== 200) return null;
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!['text/css', 'text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript'].includes(type)) return null;
  // Guard against a misconfigured reverse proxy serving a login/error page as JS/CSS.
  if (/^\s*</.test(new TextDecoder().decode(response.body.subarray(0, 256)))) return null;
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const length = declaredBytes(response.headers);
  // CORS can expose Content-Length while hiding Content-Encoding. A complete fetch
  // still validates HTTP body framing, so its positive declared length gives encoded
  // payload bytes even when the JS-visible body has been transparently decompressed.
  if (response.headers.has('content-length')) return length !== null && length > 0 ? length : null;
  if (encoding && encoding !== 'identity') return null;
  // With both headers hidden, a CORS body might be decoded; its length cannot establish
  // transferred bytes. Native/same-origin responses expose compression metadata.
  if (response.type === 'cors' && encoding !== 'identity') return null;
  return response.body.byteLength;
}

async function downloadReference(base: string, config: Record<string, unknown>, options: ProbeOptions,
  budget: Budget): Promise<Pick<SiteProbeResult, 'download' | 'downloadNote'>> {
  const server = config.server as Record<string, unknown> | undefined;
  let candidates: URL[];
  if (server?.name === 'Vaultwarden') {
    // These public resources are shipped by Vaultwarden even with its web vault disabled.
    candidates = ['bootstrap.css', 'datatables.js'].map(file => new URL(`${base}/vw_static/${file}`));
  } else {
    try {
      const response = await publicRequest(new URL(`${base}/`), options, budget, 128 * 1024, 8000, 'text/html');
      candidates = assetCandidates(new TextDecoder().decode(response.body), base);
    } catch {
      checkAbort(options.signal);
      return { download: null, downloadNote: '无法读取站点公开资源，下载参考暂不可用' };
    }
  }
  let bytes = 0;
  let durationMs = 0;
  let unverifiableTransferSize = false;
  for (const url of candidates) {
    checkAbort(options.signal);
    if (budget.remaining <= 0) break;
    try {
      const response = await publicRequest(url, options, budget, 2 * 1024 * 1024, 8000, '*/*');
      const size = staticPayloadBytes(response);
      if (size === null) {
        unverifiableTransferSize ||= !!response.headers.get('content-encoding') || response.type === 'cors';
        continue;
      }
      bytes += size;
      durationMs += response.durationMs;
      if (bytes >= 64 * 1024 && durationMs >= 10) {
        return { download: { bytes, durationMs, bytesPerSecond: bytes * 1000 / durationMs }, downloadNote: null };
      }
    } catch { checkAbort(options.signal); }
  }
  checkAbort(options.signal);
  const downloadNote = bytes >= 64 * 1024 ? '资源下载耗时过短，暂无法给出稳定的下载参考'
    : bytes > 0 ? '公开资源样本过小，暂无法给出稳定的下载参考'
      : unverifiableTransferSize ? '公开资源缺少可验证的传输大小，下载参考暂不可用'
        : '没有可用于测速的公开静态资源，下载参考暂不可用';
  return { download: null, downloadNote };
}

/** Only public configuration/static resources are requested; this never uses an account client.
 * Download is an effective payload rate including request/bridge time, not peak bandwidth:
 * uncompressed body bytes, or a complete compressed response's trustworthy Content-Length.
 * Both encoded and decoded payloads stay inside the aggregate four-MiB budget. */
export async function probeServer(serverUrl: string, options: ProbeOptions): Promise<SiteProbeResult> {
  const base = registrationServerUrl(serverUrl);
  checkAbort(options.signal);
  const budget = { remaining: TOTAL_BYTES };
  const timings: number[] = [];
  let config: Record<string, unknown> = {};
  let lastFailure: unknown;
  const endpoint = `${serverEnvironment(base).api}/config`;
  for (let sample = 0; sample < 3; sample++) {
    checkAbort(options.signal);
    try {
      const response = await publicRequest(new URL(endpoint), options, budget, CONFIG_BYTES, 4000, 'application/json');
      config = validConfig(response.body);
      timings.push(response.durationMs);
    } catch (error) {
      lastFailure = error;
      checkAbort(options.signal);
    }
  }
  checkAbort(options.signal);
  if (!timings.length) {
    const failure = lastFailure as { kind?: unknown; fingerprint?: string; status?: number } | undefined;
    if (isApiErrorKind(failure?.kind)) {
      const detail = lastFailure instanceof Error ? lastFailure.message : '连接请求失败';
      throw new ApiError(failure.kind, `无法测量服务器延迟：${detail}`, {
        cause: lastFailure,
        ...(failure.fingerprint === undefined ? {} : { fingerprint: failure.fingerprint }),
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
    }
    throw new Error('无法测量服务器延迟，请检查服务器地址或网络连接');
  }
  timings.sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  const latencyMs = timings.length % 2 ? timings[middle]! : (timings[middle - 1]! + timings[middle]!) / 2;
  const download = options.mode === 'full' ? await downloadReference(base, config, options, budget)
    : { download: null, downloadNote: null };
  checkAbort(options.signal);
  return { serverUrl: base, latencyMs, samples: timings.length, ...download };
}
