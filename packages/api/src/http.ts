import { ApiError, classifyStatus, messageFor } from './errors';

export interface HttpOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 每次请求时求值，方便注入最新的 token */
  headers?: () => Record<string, string>;
}

export interface RequestOptions {
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * 非 2xx 时不抛错，把 Response 交回调用方。
   * 用于必须自己看状态码与 body 的场景 —— 目前只有 2FA 检测
   * （它和「密码错误」都是 400，先抛错就分辨不出来了）。
   */
  allowErrorStatus?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headerFn: (() => Record<string, string>) | undefined;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headerFn = opts.headers;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError('malformedResponse', '服务器返回的不是合法 JSON', {
        status: res.status, body: text.slice(0, 200),
      });
    }
  }

  /** 不解析响应体 —— 用于需要看原始状态码与 body 的场景 */
  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.headerFn?.(),
      ...opts.headers,
    };
    let body: string | undefined;

    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      body = new URLSearchParams(opts.form).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === 'AbortError';
      throw new ApiError(
        aborted ? 'timeout' : 'network',
        aborted ? '请求超时' : '连不上服务器，请检查地址与网络',
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok && !opts.allowErrorStatus) {
      const parsed = await safeBody(res);
      throw new ApiError(classifyStatus(res.status), messageFor(parsed), {
        status: res.status, body: parsed,
      });
    }
    return res;
  }
}

/** 错误体可能是 JSON、纯文本或空 —— 解析失败绝不能盖过真正的原因 */
export async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (text.length === 0) return null;
  try { return JSON.parse(text); } catch { return text; }
}
