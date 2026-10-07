/**
 * 把 `@coffer/api` 的 `fetchImpl` 接缝接到 Rust 侧的原生 HTTP 上。
 *
 * ## 为什么不能直接用 WebView 的 fetch
 *
 * 页面的 origin 是 `tauri://localhost`，向 Vaultwarden 发请求即跨源。
 * 浏览器安全模型要求响应带 `Access-Control-Allow-Origin`，而 Vaultwarden
 * 只对**配置的 DOMAIN** 回显该头 —— `tauri://localhost` 永远拿不到。
 * 于是 WebView 会把整个响应拦掉，`fetch` 抛 TypeError，界面只能显示
 * 「连不上服务器」。这与网络好坏无关，改配置也解决不了。
 *
 * 走 Rust 侧发出请求就没有同源策略这回事，顺带还解决自签证书
 * 和「access token 不进入 WebView」两件事。详见 `src-tauri/src/http.rs`。
 *
 * ## 这个文件的分工
 *
 * 纯映射逻辑（构造请求、还原响应、翻译错误）单独导出，好单测；
 * `tauriFetch` 只负责把它们和 `invoke` 串起来。
 */
import { invoke } from '@tauri-apps/api/core';
// 二进制过 JSON 边界的编解码只有一处实现 —— 它错一位的症状是
// 「文件存出来是坏的」，很难联想到编码
import { toBase64, fromBase64 } from './base64';

/** Rust 侧 `http_request` 的返回形状 */
export interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  /** 文本体。与 `bodyBase64` 二选一 —— Rust 按字节是不是合法 UTF-8 决定走哪条 */
  body?: string;
  /** 二进制体（base64）。附件下载、图标走这条 */
  bodyBase64?: string;
}

/** Rust 侧 `HttpError` 的形状 */
export interface NativeError {
  kind: string;
  message: string;
  fingerprint?: string;
}

/** 传给 Rust 的请求载荷（字段名与 `HttpRequest` 的 serde 重命名一致） */
export interface NativeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** 文本体。与 `bodyBase64` 二选一 */
  body?: string;
  /** 二进制体（base64）。附件上传走这条 —— Rust 侧解回字节 */
  bodyBase64?: string;
  timeoutMs?: number;
}

/** 桌面端默认超时。比 api 层的 30s 略长 —— 让 api 层先超时，报错信息更准确。 */
const DEFAULT_TIMEOUT_MS = 35_000;

/** 这些状态码按规范不允许带响应体，`new Response(body, ...)` 会直接抛错 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * 传输层错误：带上分类，让 api 层的 `HttpClient` 原样采用而不是压成 `network`。
 *
 * `name` 保持 `Error`，这样 `instanceof Error` 仍然成立；
 * 分类信息靠 `kind` 字段传递（见 `packages/api/src/http.ts` 的 catch）。
 */
export class TransportError extends Error {
  readonly kind: string;
  readonly fingerprint: string | undefined;

  constructor(kind: string, message: string, fingerprint?: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.fingerprint = fingerprint;
  }
}

export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * 把 fetch 的各种 `headers` 形态收敛成普通对象。
 *
 * 注意用 `Headers` 归一化而不是直接读 `init.headers` —— 调用方可能传
 * `Headers` 实例、二维数组或普通对象，三种都要能处理。
 */
export function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const source = init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined);
  if (source === undefined) return {};
  const out: Record<string, string> = {};
  new Headers(source).forEach((v, k) => { out[k] = v; });
  return out;
}

/**
 * 取出请求体，**分成文本与二进制两条路**。
 *
 * ⚠️ 二进制必须走 base64，不能拿 `TextDecoder` 转字符串 ——
 * 那不是转错，是**静默改字节**：不合法的 UTF-8 序列会被替换成 U+FFFD。
 * 附件上传走的就是这条路，传上去的文件会损坏，而**上传会成功**，
 * 用户要等下载回来才发现。Tauri 的 IPC 是 JSON，二进制只能编码过去。
 *
 * 用**独立字段**而不是在字符串前面加魔法前缀：前缀要靠双方都记得检查，
 * 而独立字段是类型层面的区分，忘了处理会直接是 undefined。
 */
export async function bodyPartsOf(
  input: RequestInfo | URL, init?: RequestInit,
): Promise<{ body?: string; bodyBase64?: string }> {
  const raw = init?.body ?? (typeof input === 'object' && 'body' in input ? input.body : null);
  if (raw === null || raw === undefined) return {};

  if (typeof raw === 'string') return { body: raw };
  if (raw instanceof URLSearchParams) return { body: raw.toString() };

  const bytes = await bytesOf(raw);
  if (bytes === null) return { body: String(raw) };

  const text = decodeIfUtf8(bytes);
  // 是合法 UTF-8 就当文本走（中文也是），否则当二进制
  return text === undefined ? { bodyBase64: toBase64(bytes) } : { body: text };
}

/** 兼容旧调用点：只要文本那一半 */
export async function bodyOf(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  return (await bodyPartsOf(input, init)).body;
}

async function bytesOf(raw: unknown): Promise<Uint8Array | null> {
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return new Uint8Array(await raw.arrayBuffer());
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

/** 能**无损**当文本读就返回文本，否则 undefined —— 出现替换字符就说明原本不是文本 */
function decodeIfUtf8(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.includes('\uFFFD') ? undefined : text;
}


export async function toNativeRequest(
  input: RequestInfo | URL, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NativeRequest> {
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET')
    .toUpperCase();
  const parts = await bodyPartsOf(input, init);
  return {
    method,
    url: urlOf(input),
    headers: headersOf(input, init),
    // 无 body 时不要传 `body: undefined` —— serde 的 Option 收到 null 与收到
    // 缺失字段行为不同，少传更干净
    ...parts,
    timeoutMs,
  };
}

/**
 * 还原成 `Response`。
 *
 * ⚠️ `Set-Cookie` 必须丢掉：`new Response()` 的 header guard 是 "response"，
 * 设置它按规范会抛 TypeError，一个无关的响应头不该让整个请求失败。
 */
export function toResponse(native: NativeResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(native.headers)) {
    if (k.toLowerCase() === 'set-cookie') continue;
    try { headers.set(k, v); } catch { /* 非法头名 —— 跳过，不影响其余 */ }
  }
  // ⚠️ 二进制走 `bodyBase64`。只认 `body` 的话，下载的附件与图标会变成
  // **空响应**，而状态码是 200 —— 看起来一切正常，存下来是 0 字节。
  const body = NULL_BODY_STATUS.has(native.status) ? null
    : native.bodyBase64 !== undefined ? fromBase64(native.bodyBase64)
      : native.body ?? null;

  return new Response(body, {
    status: native.status,
    statusText: '',
    headers,
  });
}

/**
 * 把 Rust 侧的错误翻译成 `TransportError`。
 *
 * 传进来的未必是我们的 `HttpError` —— `invoke` 在命令本身失败（未注册、
 * 参数反序列化失败）时给的是字符串。那种情况退化成 network，别让用户
 * 看到一串内部错误。
 */
export function toTransportError(raw: unknown): TransportError {
  if (typeof raw === 'object' && raw !== null && typeof (raw as NativeError).kind === 'string') {
    const e = raw as NativeError;
    return new TransportError(e.kind, e.message, e.fingerprint);
  }
  const message = typeof raw === 'string' && raw.length > 0 ? raw : '请求失败';
  return new TransportError('network', message);
}

/** 当前是否运行在 Tauri 壳里（浏览器里跑 `vite dev` 时为 false） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 符合 `fetch` 签名的传输实现，直接交给 `new HttpClient({ fetchImpl: tauriFetch })`。
 */
export const tauriFetch: typeof fetch = async (input, init) => {
  if (!isTauri()) {
    // 在纯浏览器里跑（`bun run dev` 直接开页面）时没有 Rust 侧可调，
    // 明确报错而不是抛一个看不懂的 invoke 失败
    throw new TransportError('network', '当前不在 1Warden 桌面端中运行，无法发起请求');
  }

  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const req = await toNativeRequest(input, init);

  let native: NativeResponse;
  try {
    native = await invoke<NativeResponse>('http_request', { req });
  } catch (e) {
    throw toTransportError(e);
  }

  // 请求在 Rust 侧已经回来了，但调用方可能已经放弃等它 —— 仍然按中止处理，
  // 否则上层会拿着一个它已经不想要的响应继续走
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return toResponse(native);
};
