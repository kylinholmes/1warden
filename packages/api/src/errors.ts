export type ApiErrorKind =
  | 'network' | 'timeout' | 'auth' | 'twoFactorRequired' | 'twoFactorInvalid'
  | 'rateLimited' | 'notFound' | 'conflict' | 'server' | 'malformedResponse';

export interface ApiErrorInit {
  status?: number;
  body?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly body: unknown;

  constructor(kind: ApiErrorKind, message: string, init: ApiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.kind = kind;
    this.status = init.status;
    this.body = init.body;
  }
}

/**
 * 把 HTTP 状态码映射成调用方能分流的类别。
 *
 * 上层需要能区分「密码错」和「连不上服务器」并给出不同的提示 ——
 * 这是解锁屏的明确要求。若底层 TypeError 直接漏出去，UI 只能显示一句无意义的报错。
 */
export function classifyStatus(status: number): ApiErrorKind {
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  if (status >= 400) return 'auth';
  return 'server';
}

/**
 * 任何看起来像密文或凭据的字符串都不许进入错误消息 ——
 * 它会被渲染到 UI 上，也可能被写进日志或崩溃报告。
 *
 * 匹配三种形态：
 *   1. 完整 EncString `类型.段|段|段` —— 段可以很短，不能假设最小长度
 *   2. `类型.长base64`（无分隔符的变体）
 *   3. JWT（`eyJ...` 开头且至少三段）
 *
 * ⚠️ 不要给第一段设最小长度门槛：`2.AB|CD|EF` 同样是合法密文，
 * 门槛设高了就会漏掉短密文 —— 这正是本文件曾经的真实缺陷。
 */
const SENSITIVE =
  /(\b\d\.[A-Za-z0-9+/=]*\|[A-Za-z0-9+/=]+)|(\b\d\.[A-Za-z0-9+/=]{12,})|(\beyJ[A-Za-z0-9_-]{10,})/;

const GENERIC = '服务器返回了一个错误';
const FALLBACK = '请求失败，请稍后重试';

function sanitise(text: string): string {
  return SENSITIVE.test(text) ? GENERIC : text;
}

/** 从 Vaultwarden 的错误体里取出可展示的消息。永不让解析失败盖过真正的原因。 */
export function messageFor(body: unknown): string {
  if (typeof body === 'string') {
    const t = body.trim();
    if (t.length === 0 || t.length > 300) return FALLBACK;
    return sanitise(t);
  }
  if (body === null || typeof body !== 'object') return FALLBACK;

  const b = body as Record<string, unknown>;
  const errorModel = b['errorModel'] as Record<string, unknown> | undefined;
  for (const candidate of [b['message'], errorModel?.['message'], b['error_description']]) {
    if (typeof candidate === 'string') {
      const t = candidate.trim();
      if (t.length > 0 && t.length <= 300) return sanitise(t);
    }
  }
  return FALLBACK;
}
