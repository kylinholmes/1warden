# 1Warden 计划 2：Bitwarden REST 客户端 (@1warden/api)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `@1warden/api` —— 一个只认 HTTP 与原始 JSON、**完全不碰解密**的 Bitwarden/Vaultwarden REST 客户端，并通过针对真实 Vaultwarden 实例的契约测试。

**Architecture:** 纯传输层。它把请求发出去、把响应解析成带类型的 DTO、把失败归一成结构化错误，但**不理解任何密文**（`name`/`notes` 等字段对它就是不透明字符串）。解密是 `@1warden/vault` 的事。这条边界让协议可以被独立测试，也让「协议写错了」和「解密写错了」是两种可区分的失败。

**Tech Stack:** TypeScript (strict) · Bun · Vitest · 原生 `fetch` · 无运行时依赖

**Spec:** `docs/superpowers/specs/2026-10-04-onewarden-design.md`
**实测参考（本文档的事实来源）:** `docs/reference/bitwarden-api-notes.md`

## Global Constraints

- **零运行时依赖**：只用平台自带的 `fetch` / `URLSearchParams` / `AbortController`
- **`@1warden/api` 不做任何密码学**：不导入 `@1warden/crypto`，不解析 EncString，不碰密钥
- **绝不把含密钥的请求体写进日志或错误消息**：`password`、`masterPasswordHash`、`access_token`、`refresh_token`、任何 `2.` 开头的字符串
- **所有错误必须是 `ApiError`**：不得让 `TypeError` / `DOMException` 漏出去
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，不允许 `any`
- 目标运行时：Node 26 / 现代浏览器 / Tauri WebView / 移动端（见下方约束）
- 服务端**不分页**（`/api/sync` 一次性全量返回）—— 不要写分页代码

### 接口稳定性原则（用户明确要求）

> **只依赖长期不变的核心接口，以支持尽可能大的服务端版本跨度。**
> 完整分级见 `docs/reference/bitwarden-api-notes.md` §9.5。

- **只调用 🟢 稳定层**的端点。🟡 层的字段必须**两种形态都吃**。🔴 层的端点**一律不碰**
- **新字段一律「有就用，没有就降级」**，绝不因为缺字段而崩溃
- **读响应必须容忍多余字段** —— 服务端加字段不应影响我们
- `/api/config` 的 `version` **只用于能力探测，绝不用于拒绝服务**
- 写请求只发稳定字段。唯一例外是 `encryptedFor`：当前 Vaultwarden 必填，
  而老服务端会忽略未知字段 —— 无条件发送在两个方向上都是安全的

### 目标平台约束（移动端已纳入范围）

- **核心包不得假设存在 DOM** —— 不引用 `window`、`document`、`localStorage`
- **不得依赖 Node 专有 API**（`Buffer`、`node:crypto`、`fs`）—— 移动端没有
- 若某能力在目标平台缺失（如 React Native 的 WebCrypto），必须在**核心包之外**注入，
  核心包只依赖注入进来的实现。具体方案的结论见移动端调研

## Review Focus

以下是 spec 与实测记录里**最容易写错、且错了很难发现**的点。每个都在拥有该代码的任务里配了测试：

1. **`encryptedFor` 是必填字段** — 缺失导致的是**反序列化失败**（400/422），不是校验错误。写死在每个写请求里。
2. **软删除与硬删除的动词是反的** — `PUT /ciphers/{id}/delete` = 进回收站；`POST`/`DELETE` = 永久删除。写反了用户会永久丢数据，且**没有撤销**。
3. **`folderId` 省略会静默把条目移出文件夹** — 全量 PUT 时必须显式发送（无文件夹就发 `null`）。
4. **`archivedDate` 语义是反的** — `Some(date)` = 归档；`None` = **取消归档**。全量 PUT 省略它 = 取消归档。
5. **prelogin 是 camelCase，token 端点是 PascalCase** — 同一个服务端两种风格。只认一种会读不到值。
6. **`/api/sync` 会返回已删除和已归档的条目** — 服务端不做过滤。客户端必须自己分区，否则已删除的密码会出现在列表里。
7. **服务端版本跨度** — 同一个客户端要能对付从旧版 Bitwarden 到最新 Vaultwarden 的整个范围。任何「缺字段就崩」「多余字段就崩」「大小写只认一种」的写法都会把可支持的版本范围切掉一大块。

---

## Task 1: 包骨架 + 错误模型 + HTTP 核心

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/src/errors.ts`
- Create: `packages/api/src/http.ts`
- Test: `packages/api/src/errors.test.ts`
- Test: `packages/api/src/http.test.ts`
- Modify: `tsconfig.json`（根，加 project reference）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ApiErrorKind = 'network' | 'timeout' | 'auth' | 'twoFactorRequired' | 'twoFactorInvalid' | 'rateLimited' | 'notFound' | 'conflict' | 'server' | 'malformedResponse'`
  - `class ApiError extends Error { readonly kind: ApiErrorKind; readonly status: number | undefined; readonly body: unknown }`
  - `interface HttpOptions { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; headers?: () => Record<string,string> }`
  - `class HttpClient { request<T>(method, path, opts?): Promise<T>; requestRaw(method, path, opts?): Promise<Response> }`

> **为什么错误必须归一**：调用方需要能区分「密码错」和「连不上服务器」并给出不同提示 —— 这是 spec 里解锁屏的明确要求。若底层 `fetch` 的 `TypeError` 直接漏出去，UI 只能显示一句无意义的报错。

- [ ] **Step 1: 创建包配置**

`packages/api/package.json`:
```json
{
  "name": "@1warden/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

根 `tsconfig.json` 的 `references` 追加 `{ "path": "./packages/api" }`。

- [ ] **Step 2: 写失败的测试 `packages/api/src/errors.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { ApiError, classifyStatus, messageFor } from './errors';

describe('ApiError', () => {
  it('carries kind, status and body', () => {
    const e = new ApiError('auth', '用户名或密码错误', { status: 400, body: { message: 'x' } });
    expect(e.kind).toBe('auth');
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ message: 'x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ApiError');
  });

  it('allows an undefined status for transport failures', () => {
    expect(new ApiError('network', '连不上').status).toBeUndefined();
  });
});

describe('classifyStatus', () => {
  it('maps HTTP status to a kind', () => {
    expect(classifyStatus(400)).toBe('auth');
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(404)).toBe('notFound');
    expect(classifyStatus(409)).toBe('conflict');
    expect(classifyStatus(429)).toBe('rateLimited');
    expect(classifyStatus(500)).toBe('server');
    expect(classifyStatus(503)).toBe('server');
  });
});

describe('messageFor', () => {
  it('extracts the human message from a Vaultwarden error body', () => {
    expect(messageFor({ message: 'Username or password is incorrect. Try again' }))
      .toBe('Username or password is incorrect. Try again');
  });

  it('falls back to errorModel.message', () => {
    expect(messageFor({ errorModel: { message: 'Out of date' } })).toBe('Out of date');
  });

  it('falls back to a generic message for an unknown shape', () => {
    expect(messageFor(null)).toBeTruthy();
    expect(messageFor('a plain string')).toBeTruthy();
  });

  // 错误消息会被渲染到 UI 上，绝不能把 token / 密钥带出去
  it('never echoes a value that looks like an EncString or a token', () => {
    const leaky = { message: 'failed', key: '2.abcdefghijklmnop|qrstuvwxyz|0123456789' };
    expect(messageFor(leaky)).not.toContain('2.');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun run test packages/api/src/errors.test.ts`
Expected: FAIL —— 无法解析模块 `./errors`

- [ ] **Step 4: 实现 `packages/api/src/errors.ts`**

```ts
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

export function classifyStatus(status: number): ApiErrorKind {
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  if (status >= 400) return 'auth';
  return 'server';
}

/** 任何看起来像密文或凭据的字符串都不许进入错误消息 —— 它会被渲染到 UI 上 */
const SENSITIVE = /(\b\d\.[A-Za-z0-9+/=]{8,})|(\beyJ[A-Za-z0-9_-]{10,})/;

function sanitise(text: string): string {
  return SENSITIVE.test(text) ? '服务器返回了一个错误' : text;
}

/** 从 Vaultwarden 的错误体里取出可展示的消息 */
export function messageFor(body: unknown): string {
  const fallback = '请求失败，请稍后重试';
  if (typeof body === 'string') {
    const t = body.trim();
    return t.length > 0 && t.length < 300 ? sanitise(t) : fallback;
  }
  if (body === null || typeof body !== 'object') return fallback;

  const b = body as Record<string, unknown>;
  for (const candidate of [
    b['message'],
    (b['errorModel'] as Record<string, unknown> | undefined)?.['message'],
    b['error_description'],
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return sanitise(candidate.trim());
    }
  }
  return fallback;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test packages/api/src/errors.test.ts`
Expected: PASS

- [ ] **Step 6: 写失败的测试 `packages/api/src/http.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { ApiError } from './errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpClient', () => {
  it('GETs and parses JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await http.request('GET', '/api/config')).toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/api/config');
  });

  it('joins baseUrl and path without doubling slashes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://x.test/', fetchImpl });
    await http.request('GET', '/api/config');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/api/config');
  });

  it('sends a form body with the urlencoded content type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await http.request('POST', '/identity/connect/token', { form: { grant_type: 'password' } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded; charset=utf-8');
    expect(String(init.body)).toBe('grant_type=password');
  });

  it('attaches caller-supplied headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl, headers: () => ({ Authorization: 'Bearer t' }),
    });
    await http.request('GET', '/api/sync');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer t');
  });

  it('returns undefined for a 204 with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await http.request('POST', '/api/x')).toBeUndefined();
  });

  it('throws ApiError(network) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws ApiError(timeout) when the request exceeds timeoutMs', async () => {
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws ApiError(malformedResponse) when a 200 body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('classifies a non-2xx status and keeps the parsed body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Username or password is incorrect' }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('POST', '/identity/connect/token')).rejects.toMatchObject({
      kind: 'auth', status: 400,
    });
  });

  // Vaultwarden 的 401 是纯文本（认证守卫失败），不是 JSON
  it('handles a plain-text error body without throwing a parse error', async () => {
    const fetchImpl = vi.fn(async () => new Response('Invalid claim', { status: 401 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/sync')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('lets a caller read the raw Response (needed for 2FA detection)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ TwoFactorProviders: ['0'] }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    const res = await http.requestRaw('POST', '/identity/connect/token');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ TwoFactorProviders: ['0'] });
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `bun run test packages/api/src/http.test.ts`
Expected: FAIL —— 无法解析模块 `./http`

- [ ] **Step 8: 实现 `packages/api/src/http.ts`**

```ts
import { ApiError, classifyStatus, messageFor } from './errors';

export interface HttpOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 每次请求时求值，方便注入最新 token */
  headers?: () => Record<string, string>;
}

export interface RequestOptions {
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
      throw new ApiError('malformedResponse', '服务器返回的不是合法 JSON', { status: res.status, body: text.slice(0, 200) });
    }
  }

  /** 不解析响应体 —— 用于需要看原始状态码与 body 的场景（2FA 检测） */
  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.headerFn?.(), ...opts.headers };
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
        method, headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      throw new ApiError(
        aborted ? 'timeout' : 'network',
        aborted ? '请求超时' : '连不上服务器，请检查地址与网络',
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ApiError(classifyStatus(res.status), messageFor(await safeBody(res)), {
        status: res.status, body: undefined,
      });
    }
    return res;
  }
}

/** 错误体可能是 JSON、纯文本或空 —— 都不能让解析失败盖过真正的原因 */
async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (text.length === 0) return null;
  try { return JSON.parse(text); } catch { return text; }
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `bun run test packages/api/src/http.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 10: Commit**

```bash
git add packages/api tsconfig.json
git commit -m "feat(api): add HTTP core with a normalised error model"
```

---

## Task 2: 服务器配置 + prelogin（含大小写陷阱）

**Files:**
- Create: `packages/api/src/config.ts`
- Create: `packages/api/src/prelogin.ts`
- Test: `packages/api/src/prelogin.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HttpClient`、`ApiError`
- Produces:
  - `interface ServerConfig { version: string; serverName: string; environment: { vault, api, identity, notifications, icons, events } }`
  - `getServerConfig(http: HttpClient): Promise<ServerConfig>`
  - `interface PreloginResult { kdf: 0 | 1; iterations: number; memory: number | undefined; parallelism: number | undefined }`
  - `prelogin(http: HttpClient, email: string): Promise<PreloginResult>`

> ⚠️ **本任务最关键的实现细节**：`/identity/accounts/prelogin` 在 **Vaultwarden 上返回 camelCase**（`kdf`/`kdfIterations`），而官方服务端返回 PascalCase，token 端点两者都是 PascalCase。已对运行中的 Vaultwarden 1.37.3 实测确认。只认一种大小写会导致「KDF 参数为 undefined → 派生出的密钥全错 → 提示密码错误」，且毫无线索指向大小写。

- [ ] **Step 1: 写失败的测试 `packages/api/src/prelogin.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { prelogin, getServerConfig } from './prelogin';

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

describe('prelogin', () => {
  // Vaultwarden 1.37.3 的真实响应（已实测）
  it('parses the camelCase shape Vaultwarden actually returns', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({
        kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null, salt: null,
      }),
    });
    expect(await prelogin(http, 'a@b.com')).toEqual({
      kdf: 0, iterations: 600000, memory: undefined, parallelism: undefined,
    });
  });

  it('also parses the PascalCase shape the official server returns', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ Kdf: 1, KdfIterations: 3, KdfMemory: 64, KdfParallelism: 4 }),
    });
    expect(await prelogin(http, 'a@b.com')).toEqual({
      kdf: 1, iterations: 3, memory: 64, parallelism: 4,
    });
  });

  it('POSTs the email to the identity prelogin endpoint', async () => {
    const fetchImpl = respond({ kdf: 0, kdfIterations: 600000 });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await prelogin(http, 'a@b.com');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/identity/accounts/prelogin');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({ email: 'a@b.com' });
  });

  // 读不到值时必须响亮失败，而不是让 undefined 一路传到密钥派生里
  it('throws malformedResponse when the KDF fields are missing entirely', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ salt: null }) });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('rejects an unknown kdf type number', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ kdf: 99, kdfIterations: 1 }) });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });
});

describe('getServerConfig', () => {
  it('parses the Vaultwarden config shape', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({
        version: '2026.6.0',
        server: { name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden' },
        environment: { vault: 'https://x.test', api: 'https://x.test/api', identity: 'https://x.test/identity', notifications: 'https://x.test/notifications' },
        settings: { disableUserRegistration: false },
      }),
    });
    const cfg = await getServerConfig(http);
    expect(cfg.version).toBe('2026.6.0');
    expect(cfg.serverName).toBe('Vaultwarden');
    expect(cfg.environment.identity).toBe('https://x.test/identity');
  });

  it('tolerates a config with no environment block', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ version: '1', server: { name: 'X' } }),
    });
    const cfg = await getServerConfig(http);
    expect(cfg.environment.identity).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/api/src/prelogin.test.ts`
Expected: FAIL —— 无法解析模块 `./prelogin`

- [ ] **Step 3: 实现 `packages/api/src/prelogin.ts`**

```ts
import { ApiError } from './errors';
import type { HttpClient } from './http';

export interface ServerConfig {
  version: string;
  serverName: string;
  environment: {
    vault: string | undefined;
    api: string | undefined;
    identity: string | undefined;
    notifications: string | undefined;
    icons: string | undefined;
    events: string | undefined;
  };
}

export interface PreloginResult {
  kdf: 0 | 1;
  iterations: number;
  memory: number | undefined;
  parallelism: number | undefined;
}

function pick(raw: Record<string, unknown>, lower: string, upper: string): unknown {
  return raw[lower] ?? raw[upper];
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function getServerConfig(http: HttpClient): Promise<ServerConfig> {
  const raw = await http.request<Record<string, unknown>>('GET', '/api/config');
  const server = (raw['server'] ?? {}) as Record<string, unknown>;
  const env = (raw['environment'] ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

  return {
    version: str(raw['version']) ?? 'unknown',
    serverName: str(server['name']) ?? 'unknown',
    environment: {
      vault: str(env['vault']),
      api: str(env['api']),
      identity: str(env['identity']),
      notifications: str(env['notifications']),
      icons: str(env['icons']),
      events: str(env['events']),
    },
  };
}

/**
 * ⚠️ 字段大小写**在服务端之间不一致**：
 *   prelogin   → Vaultwarden 是 camelCase，官方服务端是 PascalCase
 *   token 端点 → 两者都是 PascalCase
 * 两种都吃。只认一种会得到 undefined，随后被拿去派生出全错的密钥，
 * 最终表现为「密码错误」—— 完全指不到真正的原因。
 */
export async function prelogin(http: HttpClient, email: string): Promise<PreloginResult> {
  const raw = await http.request<Record<string, unknown>>(
    'POST', '/identity/accounts/prelogin', { json: { email } },
  );

  const kdf = asNumber(pick(raw, 'kdf', 'Kdf'));
  const iterations = asNumber(pick(raw, 'kdfIterations', 'KdfIterations'));
  if (kdf === undefined || iterations === undefined) {
    throw new ApiError('malformedResponse', '服务器没有返回 KDF 参数', { body: raw });
  }
  if (kdf !== 0 && kdf !== 1) {
    throw new ApiError('malformedResponse', `不支持的 KDF 类型：${kdf}`, { body: raw });
  }

  return {
    kdf,
    iterations,
    memory: asNumber(pick(raw, 'kdfMemory', 'KdfMemory')),
    parallelism: asNumber(pick(raw, 'kdfParallelism', 'KdfParallelism')),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/api/src/prelogin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api
git commit -m "feat(api): add server config and prelogin with case-tolerant parsing"
```

---

## Task 3: 认证（token 端点：密码 / 2FA / 刷新 / API Key）

**Files:**
- Create: `packages/api/src/auth.ts`
- Test: `packages/api/src/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HttpClient`、`ApiError`
- Produces:
  - `const DEVICE_TYPE = { macOSDesktop: 7, windowsDesktop: 6, chromeExtension: 2, firefoxExtension: 3, windowsCLI: 23, macOSCLI: 24 } as const`
  - `interface DeviceInfo { type: number; identifier: string; name: string }`
  - `interface TokenResponse { accessToken: string; refreshToken: string | undefined; expiresIn: number; key: string | undefined; privateKey: string | undefined; kdf: number | undefined }`
  - `class TwoFactorRequiredError extends ApiError { readonly providers: number[]; readonly providersInfo: Record<string, unknown> }`
  - `loginWithPassword(http, p: { email, masterPasswordHash, device, twoFactor?: { token, provider, remember } }): Promise<TokenResponse>`
  - `refreshToken(http, p: { refreshToken, device }): Promise<TokenResponse>`
  - `loginWithApiKey(http, p: { clientId, clientSecret, device }): Promise<TokenResponse>`

> **2FA 的检测方式**：服务器返回 **400**，body 里带 `TwoFactorProviders2`。必须先看原始状态码与 body，不能先按普通错误处理 —— 所以这里用 `requestRaw`。

- [ ] **Step 1: 写失败的测试 `packages/api/src/auth.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { loginWithPassword, refreshToken, loginWithApiKey, TwoFactorRequiredError, DEVICE_TYPE } from './auth';

const device = { type: DEVICE_TYPE.macOSCLI, identifier: 'dev-1', name: 'onewarden-test' };

const OK_TOKEN = {
  access_token: 'at', refresh_token: 'rt', expires_in: 7200,
  Key: '2.aa|bb|cc', PrivateKey: '2.dd|ee|ff', Kdf: 0, KdfIterations: 600000,
  token_type: 'Bearer', scope: 'api offline_access',
};

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function formOf(fetchImpl: ReturnType<typeof vi.fn>): URLSearchParams {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return new URLSearchParams(String(init.body));
}

describe('loginWithPassword', () => {
  it('posts the password grant with the exact scope the server requires', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'HASH', device });

    const f = formOf(fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/identity/connect/token');
    expect(f.get('grant_type')).toBe('password');
    expect(f.get('username')).toBe('a@b.com');
    expect(f.get('password')).toBe('HASH');
    // scope 必须**精确**等于这个值，服务器会拒绝其它写法
    expect(f.get('scope')).toBe('api offline_access');
    expect(f.get('client_id')).toBe('cli');
    expect(f.get('deviceType')).toBe(String(DEVICE_TYPE.macOSCLI));
    expect(f.get('deviceIdentifier')).toBe('dev-1');
  });

  it('maps the PascalCase token response to a camelCase result', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond(OK_TOKEN) });
    const tok = await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
    expect(tok).toEqual({
      accessToken: 'at', refreshToken: 'rt', expiresIn: 7200,
      key: '2.aa|bb|cc', privateKey: '2.dd|ee|ff', kdf: 0,
    });
  });

  // Vaultwarden 在 akey 为空时**整个字段缺失**，不是 null
  it('handles an absent Key field (server omits it when empty)', async () => {
    const { Key, ...withoutKey } = OK_TOKEN;
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond(withoutKey) });
    const tok = await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
    expect(tok.key).toBeUndefined();
  });

  it('includes the 2FA fields only when a two-factor token is supplied', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, {
      email: 'a@b.com', masterPasswordHash: 'H', device,
      twoFactor: { token: '123456', provider: 0, remember: true },
    });
    const f = formOf(fetchImpl);
    expect(f.get('twoFactorToken')).toBe('123456');
    expect(f.get('twoFactorProvider')).toBe('0');
    expect(f.get('twoFactorRemember')).toBe('1');
  });

  it('throws TwoFactorRequiredError carrying the provider list', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({
        error: 'invalid_grant', error_description: 'Two factor required.',
        TwoFactorProviders: ['0', '1'],
        TwoFactorProviders2: { '0': null, '1': { Email: 'u***@example.com' } },
      }, 400),
    });
    try {
      await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TwoFactorRequiredError);
      expect((e as TwoFactorRequiredError).providers).toEqual([0, 1]);
      expect((e as TwoFactorRequiredError).providersInfo['1']).toEqual({ Email: 'u***@example.com' });
    }
  });

  it('treats a 400 without TwoFactorProviders2 as a plain auth failure', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ message: 'Username or password is incorrect. Try again' }, 400),
    });
    await expect(loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'bad', device }))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies 429 as rateLimited', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ message: 'Too many login requests' }, 429),
    });
    await expect(loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device }))
      .rejects.toMatchObject({ kind: 'rateLimited' });
  });
});

describe('refreshToken', () => {
  it('uses the refresh_token grant and omits the password fields', async () => {
    const fetchImpl = respond({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200, token_type: 'Bearer' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    const tok = await refreshToken(http, { refreshToken: 'rt', device });

    const f = formOf(fetchImpl);
    expect(f.get('grant_type')).toBe('refresh_token');
    expect(f.get('refresh_token')).toBe('rt');
    expect(f.has('password')).toBe(false);
    expect(tok.accessToken).toBe('at2');
  });

  it('surfaces invalid_grant as an auth error (the caller must re-login)', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ error: 'invalid_grant' }, 400),
    });
    await expect(refreshToken(http, { refreshToken: 'stale', device }))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  // 刷新响应里没有 Key / PrivateKey —— 类型上要允许缺失
  it('returns undefined key fields when the refresh response omits them', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200 }),
    });
    const tok = await refreshToken(http, { refreshToken: 'rt', device });
    expect(tok.key).toBeUndefined();
    expect(tok.privateKey).toBeUndefined();
  });
});

describe('loginWithApiKey', () => {
  it('sends the client_credentials grant with user.<uuid> as client_id', async () => {
    const fetchImpl = respond({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', Kdf: 0 });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithApiKey(http, { clientId: 'user.abc', clientSecret: 'secret', device });

    const f = formOf(fetchImpl);
    expect(f.get('grant_type')).toBe('client_credentials');
    expect(f.get('client_id')).toBe('user.abc');
    expect(f.get('client_secret')).toBe('secret');
    expect(f.get('scope')).toBe('api');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/api/src/auth.test.ts`
Expected: FAIL —— 无法解析模块 `./auth`

- [ ] **Step 3: 实现 `packages/api/src/auth.ts`**

```ts
import { ApiError } from './errors';
import type { HttpClient } from './http';

/** 官方 DeviceType 枚举。我们用 CLI / 桌面端的值，便于服务端日志里区分。 */
export const DEVICE_TYPE = {
  android: 0, iOS: 1, chromeExtension: 2, firefoxExtension: 3,
  operaExtension: 4, edgeExtension: 5,
  windowsDesktop: 6, macOSDesktop: 7, linuxDesktop: 8,
  chromeBrowser: 9, firefoxBrowser: 10, edgeBrowser: 12,
  windowsCLI: 23, macOSCLI: 24, linuxCLI: 25,
} as const;

export interface DeviceInfo {
  type: number;
  identifier: string;
  name: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  expiresIn: number;
  /** 用户密钥（EncString）。服务端在为空时**整个字段缺失**，不是 null。 */
  key: string | undefined;
  privateKey: string | undefined;
  kdf: number | undefined;
}

export class TwoFactorRequiredError extends ApiError {
  readonly providers: number[];
  readonly providersInfo: Record<string, unknown>;

  constructor(providers: number[], providersInfo: Record<string, unknown>, body: unknown) {
    super('twoFactorRequired', '需要两步验证', { status: 400, body });
    this.name = 'TwoFactorRequiredError';
    this.providers = providers;
    this.providersInfo = providersInfo;
  }
}

function deviceFields(device: DeviceInfo): Record<string, string> {
  return {
    client_id: 'cli',
    deviceType: String(device.type),
    deviceIdentifier: device.identifier,
    deviceName: device.name,
  };
}

function toTokenResponse(raw: Record<string, unknown>): TokenResponse {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const accessToken = str(raw['access_token']);
  if (accessToken === undefined) {
    throw new ApiError('malformedResponse', '认证响应里没有 access_token', { body: raw });
  }
  return {
    accessToken,
    refreshToken: str(raw['refresh_token']),
    expiresIn: typeof raw['expires_in'] === 'number' ? raw['expires_in'] : 0,
    key: str(raw['Key']),
    privateKey: str(raw['PrivateKey']),
    kdf: typeof raw['Kdf'] === 'number' ? raw['Kdf'] : undefined,
  };
}

/** 2FA 的判定依据：状态码 400 **且** body 里有非空的 TwoFactorProviders2 */
function twoFactorFrom(res: Response, body: unknown): TwoFactorRequiredError | undefined {
  if (res.status !== 400 || body === null || typeof body !== 'object') return undefined;
  const info = (body as Record<string, unknown>)['TwoFactorProviders2'];
  if (info === null || typeof info !== 'object' || Object.keys(info as object).length === 0) return undefined;

  const providers = Array.isArray((body as Record<string, unknown>)['TwoFactorProviders'])
    ? ((body as Record<string, unknown>)['TwoFactorProviders'] as unknown[])
      .map((p) => Number(p)).filter((n) => Number.isInteger(n))
    : Object.keys(info as object).map((k) => Number(k)).filter((n) => Number.isInteger(n));

  return new TwoFactorRequiredError(providers, info as Record<string, unknown>, body);
}

export interface PasswordLoginParams {
  email: string;
  /** masterPasswordHash —— 不是主密码本身 */
  masterPasswordHash: string;
  device: DeviceInfo;
  twoFactor?: { token: string; provider: number; remember: boolean };
}

export async function loginWithPassword(http: HttpClient, p: PasswordLoginParams): Promise<TokenResponse> {
  const form: Record<string, string> = {
    grant_type: 'password',
    username: p.email.trim(),
    password: p.masterPasswordHash,
    // ⚠️ 必须精确等于这个值，服务器会拒绝其它写法
    scope: 'api offline_access',
    ...deviceFields(p.device),
  };
  if (p.twoFactor) {
    form['twoFactorToken'] = p.twoFactor.token;
    form['twoFactorProvider'] = String(p.twoFactor.provider);
    form['twoFactorRemember'] = p.twoFactor.remember ? '1' : '0';
  }

  const res = await http.requestRaw('POST', '/identity/connect/token', { form });
  // 到这里说明不是 2xx（HttpClient 已对非 2xx 抛错）—— 但 2FA 也是 400，
  // 所以必须先接住那个 ApiError 再判断，见下。
  return toTokenResponse(await res.json() as Record<string, unknown>);
}

export async function refreshToken(
  http: HttpClient,
  p: { refreshToken: string; device: DeviceInfo },
): Promise<TokenResponse> {
  const raw = await http.request<Record<string, unknown>>('POST', '/identity/connect/token', {
    form: { grant_type: 'refresh_token', refresh_token: p.refreshToken, ...deviceFields(p.device) },
  });
  return toTokenResponse(raw);
}

export async function loginWithApiKey(
  http: HttpClient,
  p: { clientId: string; clientSecret: string; device: DeviceInfo },
): Promise<TokenResponse> {
  const scope = p.clientId.startsWith('organization.') ? 'api.organization' : 'api';
  const raw = await http.request<Record<string, unknown>>('POST', '/identity/connect/token', {
    form: { grant_type: 'client_credentials', client_id: p.clientId, client_secret: p.clientSecret, scope, ...deviceFields(p.device) },
  });
  return toTokenResponse(raw);
}

export { twoFactorFrom };
```

> **`loginWithPassword` 的 2FA 处理需要绕开 `HttpClient` 的自动抛错**：因为 2FA 与「密码错误」都是 400，必须在抛错前先看 body。实现上让 `loginWithPassword` 直接调用 `requestRaw` 并在非 2xx 时自己做分类 —— 见 Step 4 的修订版本。

- [ ] **Step 4: 修正 `loginWithPassword` 的 2FA 分支**

`HttpClient.requestRaw` 对非 2xx 直接抛 `ApiError`，这会把 2FA 的 400 和真正密码错误的 400 混在一起。给 `HttpClient` 加一个「不抛错」的开关，然后改写：

`packages/api/src/http.ts` 的 `RequestOptions` 增加 `allowErrorStatus?: boolean`；`requestRaw` 在 `!res.ok && !opts.allowErrorStatus` 时才抛。测试文件里补一条：

```ts
it('does not throw when allowErrorStatus is set', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 400));
  const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
  const res = await http.requestRaw('POST', '/x', { allowErrorStatus: true });
  expect(res.status).toBe(400);
});
```

`loginWithPassword` 改为：

```ts
export async function loginWithPassword(http: HttpClient, p: PasswordLoginParams): Promise<TokenResponse> {
  const form: Record<string, string> = {
    grant_type: 'password',
    username: p.email.trim(),
    password: p.masterPasswordHash,
    scope: 'api offline_access',
    ...deviceFields(p.device),
  };
  if (p.twoFactor) {
    form['twoFactorToken'] = p.twoFactor.token;
    form['twoFactorProvider'] = String(p.twoFactor.provider);
    form['twoFactorRemember'] = p.twoFactor.remember ? '1' : '0';
  }

  const res = await http.requestRaw('POST', '/identity/connect/token', { form, allowErrorStatus: true });
  const text = await res.text();
  const body: unknown = text.length === 0 ? null : (() => { try { return JSON.parse(text); } catch { return text; } })();

  if (!res.ok) {
    // 2FA 也是 400，必须在按普通错误分类**之前**判断
    const tfa = twoFactorFrom(res, body);
    if (tfa) throw tfa;
    throw new ApiError(classifyStatus(res.status), messageFor(body), { status: res.status, body });
  }
  return toTokenResponse(body as Record<string, unknown>);
}
```

（`classifyStatus`、`messageFor` 需从 `./errors` 导入。）

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test packages/api/src/auth.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 6: Commit**

```bash
git add packages/api
git commit -m "feat(api): add token endpoint with 2FA detection and refresh"
```

---

## Task 4: 同步 + Cipher 读取 + 客户端分区

**Files:**
- Create: `packages/api/src/types.ts`
- Create: `packages/api/src/sync.ts`
- Test: `packages/api/src/sync.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HttpClient`
- Produces:
  - `interface CipherDto { id, type, name, notes, folderId, favorite, reprompt, organizationId, key, creationDate, revisionDate, deletedDate, archivedDate, edit, viewPassword, login?, card?, identity?, secureNote?, fields?, passwordHistory?, attachments? }`
  - `interface FolderDto { id: string; name: string; revisionDate: string }`
  - `interface SyncResult { profile; folders: FolderDto[]; ciphers: CipherDto[]; collections: unknown[]; revisionDate: number }`
  - `sync(http, token, opts?: { excludeDomains?: boolean }): Promise<SyncResult>`
  - `partitionCiphers(ciphers: CipherDto[]): { active: CipherDto[]; archived: CipherDto[]; trashed: CipherDto[] }`
  - `getRevisionDate(http, token): Promise<number>`

> ⚠️ **`/api/sync` 会返回已删除和已归档的条目** —— 服务端**不做过滤**。客户端必须自己分区。不过滤的话，用户删除的密码会一直出现在列表和搜索结果里。
>
> `getRevisionDate` 是性能的关键：它返回一个裸整数（epoch 毫秒）。若该值 ≤ 上次同步时间，**可以完全跳过整个 sync**。官方客户端就是这么做的。

- [ ] **Step 1: 写失败的测试 `packages/api/src/sync.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { sync, partitionCiphers, getRevisionDate } from './sync';
import type { CipherDto } from './types';

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function cipher(over: Partial<CipherDto>): CipherDto {
  return {
    id: 'c1', type: 1, name: '2.aa|bb|cc', notes: null, folderId: null,
    favorite: false, reprompt: 0, organizationId: null, key: null,
    creationDate: '2026-01-01T00:00:00.000000Z',
    revisionDate: '2026-01-01T00:00:00.000000Z',
    deletedDate: null, archivedDate: null, edit: true, viewPassword: true,
    ...over,
  };
}

describe('sync', () => {
  it('requests sync with excludeDomains and returns the parsed result', async () => {
    const fetchImpl = respond({ profile: { id: 'u1' }, folders: [], ciphers: [], collections: [], object: 'sync' });
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl, headers: () => ({ Authorization: 'Bearer t' }),
    });
    const r = await sync(http, 't');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/api/sync?excludeDomains=true');
    expect(r.ciphers).toEqual([]);
  });

  it('defaults missing arrays to empty rather than undefined', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ profile: {} }) });
    const r = await sync(http, 't');
    expect(r.folders).toEqual([]);
    expect(r.ciphers).toEqual([]);
  });
});

describe('partitionCiphers', () => {
  it('splits active / archived / trashed', () => {
    const { active, archived, trashed } = partitionCiphers([
      cipher({ id: 'live' }),
      cipher({ id: 'arch', archivedDate: '2026-02-01T00:00:00.000000Z' }),
      cipher({ id: 'gone', deletedDate: '2026-03-01T00:00:00.000000Z' }),
    ]);
    expect(active.map((c) => c.id)).toEqual(['live']);
    expect(archived.map((c) => c.id)).toEqual(['arch']);
    expect(trashed.map((c) => c.id)).toEqual(['gone']);
  });

  // 服务端不做过滤，所以「已删除的条目仍然出现在 sync 响应里」是正常现象，
  // 客户端必须自己分区 —— 否则用户删掉的密码会一直出现在搜索结果中。
  it('treats an item that is both archived and trashed as trashed', () => {
    const both = cipher({ id: 'both', archivedDate: '2026-02-01T00:00:00.000000Z', deletedDate: '2026-03-01T00:00:00.000000Z' });
    const { active, archived, trashed } = partitionCiphers([both]);
    expect(active).toEqual([]);
    expect(archived).toEqual([]);
    expect(trashed.map((c) => c.id)).toEqual(['both']);
  });

  it('handles an empty list', () => {
    expect(partitionCiphers([])).toEqual({ active: [], archived: [], trashed: [] });
  });
});

describe('getRevisionDate', () => {
  it('parses the bare integer epoch-millis response', async () => {
    const fetchImpl = vi.fn(async () => new Response('1759500000000', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await getRevisionDate(http, 't')).toBe(1759500000000);
  });

  it('throws malformedResponse for a non-numeric body', async () => {
    const fetchImpl = vi.fn(async () => new Response('"nope"', { status: 200 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(getRevisionDate(http, 't')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/api/src/sync.test.ts`
Expected: FAIL —— 无法解析模块 `./sync`

- [ ] **Step 3: 实现 `packages/api/src/types.ts`**

```ts
/**
 * 线上 JSON 的原始形态。**字段大小写必须是 lowerCamelCase** ——
 * 这是 Vaultwarden 实际发出的形式（`viewPassword`、`organizationUseTotp`、
 * `folderId`），不是 C#/TS 里的属性名。
 *
 * 这个包里所有「加密」字段都是**不透明字符串**（EncString）。api 层不解析它们。
 */

export interface CipherLoginUriDto {
  uri: string | null;
  match: number | null;
  uriChecksum?: string | null;
}

export interface CipherLoginDto {
  username?: string | null;
  password?: string | null;
  passwordRevisionDate?: string | null;
  totp?: string | null;
  uris?: CipherLoginUriDto[] | null;
  autofillOnPageLoad?: boolean | null;
  fido2Credentials?: unknown[] | null;
  /** 服务端为向后兼容自动补的，等于 uris[0].uri */
  uri?: string | null;
}

export interface CipherFieldDto {
  name: string | null;
  value: string | null;
  /** 0=Text, 1=Hidden, 2=Boolean, 3=Linked */
  type: number;
  /** 数字 ID（100–418），**不是** "login.username" 这种字符串 */
  linkedId?: number | null;
}

export interface CipherPasswordHistoryDto {
  lastUsedDate: string;
  password: string;
}

export interface CipherAttachmentDto {
  id: string;
  url: string;
  fileName: string | null;
  /** ⚠️ 是**字符串**，不是数字 */
  size: string;
  sizeName: string;
  key: string | null;
}

export interface CipherDto {
  id: string;
  /** CipherType：1=Login 2=SecureNote 3=Card 4=Identity 5=SSHKey 6=BankAccount 7=DriversLicense 8=Passport */
  type: number;
  name: string | null;
  notes: string | null;
  folderId: string | null;
  favorite: boolean;
  /** 0=None, 1=PasswordOnView */
  reprompt: number;
  organizationId: string | null;
  key: string | null;
  creationDate: string;
  revisionDate: string;
  deletedDate: string | null;
  archivedDate: string | null;
  edit?: boolean;
  viewPassword?: boolean;
  login?: CipherLoginDto | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  secureNote?: { type: number } | null;
  fields?: CipherFieldDto[] | null;
  passwordHistory?: CipherPasswordHistoryDto[] | null;
  attachments?: CipherAttachmentDto[] | null;
  collectionIds?: string[];
  organizationUseTotp?: boolean;
  permissions?: { delete?: boolean; restore?: boolean };
}

export interface FolderDto {
  id: string;
  name: string | null;
  revisionDate: string;
}

export interface ProfileDto {
  id: string;
  email: string;
  name: string | null;
  key: string | null;
  privateKey: string | null;
  [k: string]: unknown;
}

export interface SyncResult {
  profile: ProfileDto;
  folders: FolderDto[];
  ciphers: CipherDto[];
  collections: unknown[];
}

/** CipherType 常量 */
export const CIPHER_TYPE = {
  login: 1, secureNote: 2, card: 3, identity: 4,
  sshKey: 5, bankAccount: 6, driversLicense: 7, passport: 8,
} as const;

/** FieldType 常量。⚠️ Vaultwarden 在 type 缺失/不可解析时回退到 **1（Hidden）**。 */
export const FIELD_TYPE = { text: 0, hidden: 1, boolean: 2, linked: 3 } as const;
```

- [ ] **Step 4: 实现 `packages/api/src/sync.ts`**

```ts
import { ApiError } from './errors';
import type { HttpClient } from './http';
import type { CipherDto, FolderDto, ProfileDto, SyncResult } from './types';

export async function sync(
  http: HttpClient,
  _token: string,
  opts: { excludeDomains?: boolean } = {},
): Promise<SyncResult> {
  const exclude = opts.excludeDomains ?? true;
  const raw = await http.request<Record<string, unknown>>('GET', `/api/sync?excludeDomains=${exclude}`);
  return {
    profile: (raw['profile'] ?? {}) as ProfileDto,
    folders: Array.isArray(raw['folders']) ? (raw['folders'] as FolderDto[]) : [],
    ciphers: Array.isArray(raw['ciphers']) ? (raw['ciphers'] as CipherDto[]) : [],
    collections: Array.isArray(raw['collections']) ? (raw['collections'] as unknown[]) : [],
  };
}

export interface PartitionedCiphers {
  active: CipherDto[];
  archived: CipherDto[];
  trashed: CipherDto[];
}

/**
 * ⚠️ `/api/sync` **会返回已删除和已归档的条目** —— 服务端不做任何过滤。
 * 分区必须由客户端完成，否则用户删除的密码会一直出现在列表和搜索结果里。
 *
 * 同时处于归档与删除状态时，**以删除为准**（回收站优先）。
 */
export function partitionCiphers(ciphers: CipherDto[]): PartitionedCiphers {
  const active: CipherDto[] = [];
  const archived: CipherDto[] = [];
  const trashed: CipherDto[] = [];
  for (const c of ciphers) {
    if (c.deletedDate != null) trashed.push(c);
    else if (c.archivedDate != null) archived.push(c);
    else active.push(c);
  }
  return { active, archived, trashed };
}

/**
 * 服务器数据的修订时间戳（**裸整数**，epoch 毫秒）。
 * 若该值 ≤ 上次同步时间，可以完全跳过 sync —— 这是大保险库最重要的性能杠杆。
 */
export async function getRevisionDate(http: HttpClient, _token: string): Promise<number> {
  const raw = await http.request<unknown>('GET', '/api/accounts/revision-date');
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ApiError('malformedResponse', 'revision-date 不是数字', { body: raw });
  }
  return n;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test packages/api/src/sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api
git commit -m "feat(api): add sync with client-side trash/archive partitioning"
```

---

## Task 5: Cipher 写入（含动词反转与 `encryptedFor` 陷阱）

**Files:**
- Create: `packages/api/src/ciphers.ts`
- Test: `packages/api/src/ciphers.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HttpClient`；Task 4 的 `CipherDto`
- Produces:
  - `interface CipherWriteBody { encryptedFor: string; type: number; name: string; notes: string | null; folderId: string | null; organizationId: string | null; favorite: boolean; reprompt: number; key?: string | null; login?: unknown; card?: unknown; identity?: unknown; secureNote?: unknown; fields?: unknown; passwordHistory?: unknown; lastKnownRevisionDate?: string | null; archivedDate?: string | null }`
  - `createCipher(http, userId: string, body: Omit<CipherWriteBody,'encryptedFor'>): Promise<CipherDto>`
  - `updateCipher(http, id: string, userId: string, body: Omit<CipherWriteBody,'encryptedFor'>): Promise<CipherDto>`
  - `softDeleteCipher(http, id): Promise<void>` — 进回收站
  - `hardDeleteCipher(http, id): Promise<void>` — 永久删除
  - `restoreCipher(http, id): Promise<void>`
  - `setArchived(http, id, archived: boolean): Promise<void>`
  - `moveCiphers(http, folderId: string | null, ids: string[]): Promise<void>`
  - `updateCipherPartial(http, id, p: { folderId?: string|null; favorite: boolean }): Promise<void>`

> ⚠️⚠️ **本任务最危险的一点：软删除与硬删除的 HTTP 动词是反直觉的。**
>
> | 调用 | 语义 |
> |---|---|
> | `PUT /api/ciphers/{id}/delete` | **软删除**（进回收站，可恢复） |
> | `POST /api/ciphers/{id}/delete` | **硬删除**（永久） |
> | `DELETE /api/ciphers/{id}` | **硬删除**（永久） |
>
> 写反了用户会**永久丢失数据且无法恢复**。这是本计划里唯一能造成不可逆损失的代码。

- [ ] **Step 1: 写失败的测试 `packages/api/src/ciphers.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import {
  createCipher, updateCipher, softDeleteCipher, hardDeleteCipher,
  restoreCipher, setArchived, moveCiphers, updateCipherPartial,
} from './ciphers';

function respond(body: unknown = {}, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function calls(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.map(([url, init]) => ({
    url: String(url), method: (init as RequestInit).method,
    body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
  }));
}

const base = { type: 1, name: '2.aa|bb|cc', notes: null, folderId: null, organizationId: null, favorite: false, reprompt: 0 };

describe('createCipher', () => {
  it('POSTs to /api/ciphers with encryptedFor set to the given user id', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'user-uuid', base);
    const [c] = calls(fetchImpl);
    expect(c!.url).toBe('https://x.test/api/ciphers');
    expect(c!.method).toBe('POST');
    // encryptedFor 缺失会导致**反序列化失败**（不是校验错误），必须总是发送
    expect(c!.body.encryptedFor).toBe('user-uuid');
  });

  it('sends folderId explicitly even when null', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'u', base);
    expect('folderId' in calls(fetchImpl)[0]!.body).toBe(true);
    expect(calls(fetchImpl)[0]!.body.folderId).toBeNull();
  });
});

describe('updateCipher', () => {
  it('PUTs to /api/ciphers/{id}', async () => {
    const fetchImpl = respond({ id: 'c1' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', base);
    const [c] = calls(fetchImpl);
    expect(c!.url).toBe('https://x.test/api/ciphers/c1');
    expect(c!.method).toBe('PUT');
  });

  // ⚠️ 省略 folderId 会静默把条目移出文件夹 —— 全量更新必须显式发送
  it('always includes folderId so a full update cannot silently unfolder an item', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', { ...base, folderId: 'f1' });
    expect(calls(fetchImpl)[0]!.body.folderId).toBe('f1');
  });

  // ⚠️ archivedDate 语义是反的：null = 取消归档。全量更新不能无脑带上它。
  it('omits archivedDate unless the caller sets it explicitly', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', base);
    expect('archivedDate' in calls(fetchImpl)[0]!.body).toBe(false);
  });

  it('passes lastKnownRevisionDate through when supplied (optimistic concurrency)', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', { ...base, lastKnownRevisionDate: '2026-01-01T00:00:00.000000Z' });
    expect(calls(fetchImpl)[0]!.body.lastKnownRevisionDate).toBe('2026-01-01T00:00:00.000000Z');
  });
});

// ⚠️⚠️ 这一组是整个计划里最重要的测试。
// 动词写反 = 用户永久丢失数据且无法恢复。
describe('delete verbs (soft vs hard — inverted from intuition)', () => {
  it('softDeleteCipher uses PUT /delete — this is the RECOVERABLE path', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await softDeleteCipher(http, 'c1');
    const [c] = calls(fetchImpl);
    expect(c!.method).toBe('PUT');
    expect(c!.url).toBe('https://x.test/api/ciphers/c1/delete');
  });

  it('hardDeleteCipher uses DELETE /{id} — this is PERMANENT', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await hardDeleteCipher(http, 'c1');
    const [c] = calls(fetchImpl);
    expect(c!.method).toBe('DELETE');
    expect(c!.url).toBe('https://x.test/api/ciphers/c1');
    // 绝不能是 POST /delete —— 那是另一种硬删除，写错动词是安全的但语义会漂移
    expect(c!.url).not.toContain('/delete');
  });

  it('the two delete paths never collide', async () => {
    const f1 = respond(), f2 = respond();
    const h1 = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f1 });
    const h2 = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f2 });
    await softDeleteCipher(h1, 'c1');
    await hardDeleteCipher(h2, 'c1');
    expect(calls(f1)[0]!.method).not.toBe(calls(f2)[0]!.method);
  });
});

describe('restoreCipher', () => {
  it('PUTs to /restore', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await restoreCipher(http, 'c1');
    const [c] = calls(fetchImpl);
    expect(c!.method).toBe('PUT');
    expect(c!.url).toBe('https://x.test/api/ciphers/c1/restore');
  });
});

describe('setArchived', () => {
  it('PUTs to /archive when archiving', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await setArchived(http, 'c1', true);
    expect(calls(fetchImpl)[0]!.url).toBe('https://x.test/api/ciphers/c1/archive');
  });

  it('PUTs to /unarchive when unarchiving', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await setArchived(http, 'c1', false);
    expect(calls(fetchImpl)[0]!.url).toBe('https://x.test/api/ciphers/c1/unarchive');
  });
});

describe('moveCiphers', () => {
  it('POSTs {folderId, ids} to /ciphers/move', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await moveCiphers(http, 'f1', ['c1', 'c2']);
    const [c] = calls(fetchImpl);
    expect(c!.url).toBe('https://x.test/api/ciphers/move');
    expect(c!.body).toEqual({ folderId: 'f1', ids: ['c1', 'c2'] });
  });

  it('accepts null to move items out of any folder', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await moveCiphers(http, null, ['c1']);
    expect(calls(fetchImpl)[0]!.body.folderId).toBeNull();
  });
});

describe('updateCipherPartial', () => {
  it('PUTs {folderId, favorite} — the only path that works on read-only ciphers', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipherPartial(http, 'c1', { favorite: true });
    const [c] = calls(fetchImpl);
    expect(c!.url).toBe('https://x.test/api/ciphers/c1/partial');
    expect(c!.body.favorite).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/api/src/ciphers.test.ts`
Expected: FAIL —— 无法解析模块 `./ciphers`

- [ ] **Step 3: 实现 `packages/api/src/ciphers.ts`**

```ts
import type { HttpClient } from './http';
import type { CipherDto } from './types';

export interface CipherWriteBody {
  type: number;
  name: string;
  notes: string | null;
  folderId: string | null;
  organizationId: string | null;
  favorite: boolean;
  reprompt: number;
  key?: string | null;
  login?: unknown;
  card?: unknown;
  identity?: unknown;
  secureNote?: unknown;
  sshKey?: unknown;
  fields?: unknown;
  passwordHistory?: unknown;
  lastKnownRevisionDate?: string | null;
  archivedDate?: string | null;
}

/**
 * 组装请求体。
 *
 * ⚠️ 两个必须显式处理的字段：
 *   - `encryptedFor` 必填。缺失导致的是**反序列化失败**（不是校验错误），
 *     且服务端会校验它等于当前用户 uuid（否则 422 "Invalid user cipher"）。
 *   - `folderId` 必须总是发送。省略会让服务端把条目**移出文件夹**
 *     （`Option<FolderId>` 缺省得到 None，进而删除关联行）。
 *
 * `archivedDate` 语义是反的：Some(date) = 归档，None = **取消归档**。
 * 因此只在调用方显式提供时才放进去 —— 全量更新不能无脑带上它。
 */
function buildBody(userId: string, b: CipherWriteBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    encryptedFor: userId,
    type: b.type,
    name: b.name,
    notes: b.notes,
    folderId: b.folderId,
    organizationId: b.organizationId,
    favorite: b.favorite,
    reprompt: b.reprompt,
  };
  for (const k of ['key', 'login', 'card', 'identity', 'secureNote', 'sshKey', 'fields', 'passwordHistory', 'lastKnownRevisionDate', 'archivedDate'] as const) {
    if (k in b) out[k] = b[k];
  }
  return out;
}

export async function createCipher(
  http: HttpClient, userId: string, body: CipherWriteBody,
): Promise<CipherDto> {
  return http.request<CipherDto>('POST', '/api/ciphers', { json: buildBody(userId, body) });
}

export async function updateCipher(
  http: HttpClient, id: string, userId: string, body: CipherWriteBody,
): Promise<CipherDto> {
  return http.request<CipherDto>('PUT', `/api/ciphers/${id}`, { json: buildBody(userId, body) });
}

/**
 * 软删除 —— 条目进入回收站，**可恢复**。
 * ⚠️ 对应的是 `PUT /delete`。这与直觉相反：`POST /delete` 是永久删除。
 */
export async function softDeleteCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/delete`);
}

/**
 * 硬删除 —— **永久，不可恢复**，会级联删除附件文件与密码历史。
 * ⚠️ 对应的是 `DELETE /{id}`。
 */
export async function hardDeleteCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('DELETE', `/api/ciphers/${id}`);
}

export async function restoreCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/restore`);
}

export async function setArchived(http: HttpClient, id: string, archived: boolean): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/${archived ? 'archive' : 'unarchive'}`);
}

export async function moveCiphers(
  http: HttpClient, folderId: string | null, ids: string[],
): Promise<void> {
  await http.request<void>('POST', '/api/ciphers/move', { json: { folderId, ids } });
}

/** 唯一能作用于只读条目的更新路径（服务端只校验可读性，不校验可写性） */
export async function updateCipherPartial(
  http: HttpClient, id: string, p: { folderId?: string | null; favorite: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { favorite: p.favorite };
  if ('folderId' in p) body['folderId'] = p.folderId;
  await http.request<void>('PUT', `/api/ciphers/${id}/partial`, { json: body });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/api/src/ciphers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api
git commit -m "feat(api): add cipher writes with careful soft/hard delete separation"
```

---

## Task 6: 文件夹 + 账户端点

**Files:**
- Create: `packages/api/src/folders.ts`
- Create: `packages/api/src/accounts.ts`
- Test: `packages/api/src/folders.test.ts`
- Test: `packages/api/src/accounts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HttpClient`
- Produces:
  - `listFolders(http): Promise<FolderDto[]>` · `createFolder(http, name: string): Promise<FolderDto>` · `updateFolder(http, id, name): Promise<FolderDto>` · `deleteFolder(http, id): Promise<void>`
  - `getProfile(http): Promise<ProfileDto>`
  - `verifyPassword(http, masterPasswordHash: string): Promise<void>`

> Vaultwarden **没有** `DELETE /api/folders`（批量删除）和 `DELETE /api/folders/all` —— 官方客户端有，我们会 404。逐个删。

- [ ] **Step 1: 写失败的测试 `packages/api/src/folders.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { listFolders, createFolder, updateFolder, deleteFolder } from './folders';

function respond(body: unknown = {}, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function call(f: ReturnType<typeof vi.fn>, i = 0) {
  const [url, init] = f.mock.calls[i]!;
  return { url: String(url), method: (init as RequestInit).method, body: (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined };
}

describe('folders', () => {
  it('unwraps the list envelope', async () => {
    const f = respond({ data: [{ id: 'f1', name: '2.a|b|c', revisionDate: 'x' }], object: 'list', continuationToken: null });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    expect(await listFolders(http)).toEqual([{ id: 'f1', name: '2.a|b|c', revisionDate: 'x' }]);
  });

  it('returns an empty array when data is missing', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({}) });
    expect(await listFolders(http)).toEqual([]);
  });

  it('creates a folder with the encrypted name', async () => {
    const f = respond({ id: 'new', name: '2.a|b|c', revisionDate: 'x' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    await createFolder(http, '2.a|b|c');
    expect(call(f)).toMatchObject({ url: 'https://x.test/api/folders', method: 'POST' });
    expect(call(f).body).toEqual({ name: '2.a|b|c' });
  });

  it('updates via PUT /api/folders/{id}', async () => {
    const f = respond({ id: 'f1' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    await updateFolder(http, 'f1', '2.x|y|z');
    expect(call(f)).toMatchObject({ url: 'https://x.test/api/folders/f1', method: 'PUT' });
  });

  it('deletes via DELETE /api/folders/{id}', async () => {
    const f = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    await deleteFolder(http, 'f1');
    expect(call(f)).toMatchObject({ url: 'https://x.test/api/folders/f1', method: 'DELETE' });
  });
});
```

- [ ] **Step 2: 运行确认失败** — `bun run test packages/api/src/folders.test.ts` → FAIL

- [ ] **Step 3: 实现 `packages/api/src/folders.ts`**

```ts
import type { HttpClient } from './http';
import type { FolderDto } from './types';

/**
 * ⚠️ Vaultwarden **没有**批量删除文件夹的端点
 * （`DELETE /api/folders` 与 `DELETE /api/folders/all` 都会 404）—— 只能逐个删。
 * 删文件夹会删除关联行，**条目本身存活**，变成无文件夹。
 */
export async function listFolders(http: HttpClient): Promise<FolderDto[]> {
  const raw = await http.request<{ data?: unknown }>('GET', '/api/folders');
  return Array.isArray(raw?.data) ? (raw.data as FolderDto[]) : [];
}

export async function createFolder(http: HttpClient, name: string): Promise<FolderDto> {
  return http.request<FolderDto>('POST', '/api/folders', { json: { name } });
}

export async function updateFolder(http: HttpClient, id: string, name: string): Promise<FolderDto> {
  return http.request<FolderDto>('PUT', `/api/folders/${id}`, { json: { name } });
}

export async function deleteFolder(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('DELETE', `/api/folders/${id}`);
}
```

- [ ] **Step 4: 写失败的测试 `packages/api/src/accounts.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { getProfile, verifyPassword } from './accounts';

function respond(body: unknown = {}, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

describe('getProfile', () => {
  it('GETs /api/accounts/profile', async () => {
    const f = respond({ id: 'u1', email: 'a@b.com', key: '2.a|b|c', privateKey: '2.d|e|f' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    const p = await getProfile(http);
    expect(String(f.mock.calls[0]![0])).toBe('https://x.test/api/accounts/profile');
    expect(p.id).toBe('u1');
  });
});

describe('verifyPassword', () => {
  it('POSTs the hash and resolves on success', async () => {
    const f = respond({ object: 'masterPasswordPolicy' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f });
    await verifyPassword(http, 'HASH');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://x.test/api/accounts/verify-password');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ masterPasswordHash: 'HASH' });
  });

  it('propagates an auth error for a wrong password', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ message: 'Invalid password' }, 400) });
    await expect(verifyPassword(http, 'bad')).rejects.toMatchObject({ kind: 'auth' });
  });
});
```

- [ ] **Step 5: 运行确认失败** — `bun run test packages/api/src/accounts.test.ts` → FAIL

- [ ] **Step 6: 实现 `packages/api/src/accounts.ts`**

```ts
import type { HttpClient } from './http';
import type { ProfileDto } from './types';

export async function getProfile(http: HttpClient): Promise<ProfileDto> {
  return http.request<ProfileDto>('GET', '/api/accounts/profile');
}

/**
 * 校验主密码是否仍然正确。
 * 用途：修改主密码、密钥轮换、删除账户等敏感操作前的再认证。
 * 注意服务端用的是 `PasswordOrOtpData` 信封，这里只发 hash 那一路。
 */
export async function verifyPassword(http: HttpClient, masterPasswordHash: string): Promise<void> {
  await http.request<unknown>('POST', '/api/accounts/verify-password', {
    json: { masterPasswordHash },
  });
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `bun run test packages/api/src/folders.test.ts packages/api/src/accounts.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/api
git commit -m "feat(api): add folder and account endpoints"
```

---

## Task 7: 索引导出 + 契约测试（对真实 Vaultwarden）

**Files:**
- Create: `packages/api/src/index.ts`
- Create: `packages/api/src/contract.test.ts`
- Modify: `package.json`（加 `test:contract` 脚本）
- Modify: `vitest.config.ts`（排除契约测试，它们需要运行中的服务器）

**Interfaces:**
- Consumes: Task 1–6 的全部公开 API
- Produces: `bun run test:contract` —— 对运行中的 Vaultwarden 跑真实 HTTP 往返

- [ ] **Step 1: 创建 `packages/api/src/index.ts`**

```ts
export * from './errors';
export * from './http';
export * from './prelogin';
export * from './auth';
export * from './types';
export * from './sync';
export * from './ciphers';
export * from './folders';
export * from './accounts';
```

- [ ] **Step 2: 把契约测试排除出单元测试**

`vitest.config.ts` 的 `test` 增加：
```ts
exclude: ['**/node_modules/**', '**/dist/**', '**/*.contract.test.ts'],
```

`package.json` 的 scripts 增加：
```json
"test:contract": "vitest run --config vitest.contract.config.ts"
```

创建 `vitest.contract.config.ts`：
```ts
import { defineConfig } from 'vitest/config';

// 契约测试需要运行中的 Vaultwarden（./scripts/dev-server.sh start）
// 且需要先 bun run seed 建立测试账户。故意与单元测试分开，
// 让 `bun run test` 永远不需要网络。
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.contract.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
```

- [ ] **Step 3: 写契约测试 `packages/api/src/contract.test.ts`**

```ts
/**
 * 契约测试：对**真实运行中的 Vaultwarden** 跑一遍完整读写往返。
 *
 * 与单元测试的区别：单元测试用假 fetch 验证「我们发了什么」，
 * 契约测试验证「服务器是否真的接受我们发的、并返回我们期望的形状」。
 * 后者能抓到字段名拼写、大小写、必填项、状态码等只有真机才能暴露的问题。
 *
 * 前置：
 *   ./scripts/dev-server.sh start
 *   bun run seed
 *   bun run test:contract
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { HttpClient } from './http';
import { prelogin, getServerConfig } from './prelogin';
import { loginWithPassword, DEVICE_TYPE } from './auth';
import { sync, partitionCiphers, getRevisionDate } from './sync';
import { createCipher, updateCipher, softDeleteCipher, hardDeleteCipher, restoreCipher, setArchived } from './ciphers';
import { listFolders, createFolder, deleteFolder } from './folders';
import { getProfile } from './accounts';
import { CIPHER_TYPE } from './types';
import {
  deriveMasterKey, hashMasterPassword, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID,
} from '../../crypto/src/index';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

const BASE = process.env.VW_URL ?? 'https://localhost:8443';
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';

const device = { type: DEVICE_TYPE.macOSCLI, identifier: 'contract-test', name: 'onewarden-contract' };

let http: HttpClient;
let token: string;
let userId: string;

beforeAll(async () => {
  http = new HttpClient({ baseUrl: BASE });
  const cfg = await getServerConfig(http);
  expect(cfg.serverName).toBeTruthy();

  const pl = await prelogin(http, EMAIL);
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, pl.kdf === KDF_TYPE_ARGON2ID
    ? { kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
    : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations });

  const tok = await loginWithPassword(http, {
    email: EMAIL, masterPasswordHash: await hashMasterPassword(masterKey, PASSWORD), device,
  });
  token = tok.accessToken;
  http = new HttpClient({
    baseUrl: BASE, headers: () => ({ Authorization: `Bearer ${token}`, 'Device-Type': String(device.type) }),
  });
  userId = (await getProfile(http)).id;
  expect(userId).toBeTruthy();
});

describe('契约：真实服务器往返', () => {
  it('GET /api/config 返回可解析的结构', async () => {
    const cfg = await getServerConfig(new HttpClient({ baseUrl: BASE }));
    expect(cfg.version).toMatch(/\d{4}\.\d+/);
  });

  it('prelogin 返回可用的 KDF 参数', async () => {
    const pl = await prelogin(new HttpClient({ baseUrl: BASE }), EMAIL);
    expect([0, 1]).toContain(pl.kdf);
    expect(pl.iterations).toBeGreaterThan(0);
  });

  it('revision-date 返回一个数字', async () => {
    expect(typeof await getRevisionDate(http, token)).toBe('number');
  });

  it('sync 返回 profile / folders / ciphers 三个数组', async () => {
    const r = await sync(http, token);
    expect(r.profile.id).toBe(userId);
    expect(Array.isArray(r.folders)).toBe(true);
    expect(Array.isArray(r.ciphers)).toBe(true);
  });

  it('文件夹：创建 → 列表 → 改名 → 删除', async () => {
    const created = await createFolder(http, '2.contract|test|folder');
    expect(created.id).toBeTruthy();
    expect((await listFolders(http)).some((f) => f.id === created.id)).toBe(true);
    await deleteFolder(http, created.id);
    expect((await listFolders(http)).some((f) => f.id === created.id)).toBe(false);
  });

  it('条目：创建 → 读取 → 更新 → 归档 → 取消归档', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.login, name: '2.contract|item|name', notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      login: { username: null, password: null, totp: null, uris: [] },
      fields: null, passwordHistory: null,
    });
    expect(created.id).toBeTruthy();
    // encryptedFor 缺失或不对时，这里会以 422 / 反序列化失败炸掉 —— 正是我们要抓的

    const updated = await updateCipher(http, created.id, userId, {
      type: CIPHER_TYPE.login, name: '2.contract|item|renamed', notes: null,
      folderId: null, organizationId: null, favorite: true, reprompt: 0,
      login: { username: null, password: null, totp: null, uris: [] },
    });
    expect(updated.favorite).toBe(true);

    await setArchived(http, created.id, true);
    let r = await sync(http, token);
    expect(partitionCiphers(r.ciphers).archived.some((c) => c.id === created.id)).toBe(true);

    await setArchived(http, created.id, false);
    r = await sync(http, token);
    expect(partitionCiphers(r.ciphers).active.some((c) => c.id === created.id)).toBe(true);

    await hardDeleteCipher(http, created.id);
  });

  // 🔑 这一条验证「软删除后条目仍然出现在 sync 里，但被分到 trashed」——
  // 服务端不做过滤，分区是客户端的责任
  it('软删除后条目仍出现在 sync 中，但被分到 trashed；可恢复', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.secureNote, name: '2.soft|delete|test', notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 }, fields: null, passwordHistory: null,
    });
    await softDeleteCipher(http, created.id);

    const r = await sync(http, token);
    const p = partitionCiphers(r.ciphers);
    expect(p.trashed.some((c) => c.id === created.id)).toBe(true);
    expect(p.active.some((c) => c.id === created.id)).toBe(false);

    await restoreCipher(http, created.id);
    const r2 = await sync(http, token);
    expect(partitionCiphers(r2.ciphers).active.some((c) => c.id === created.id)).toBe(true);

    await hardDeleteCipher(http, created.id);
  });

  it('硬删除后条目彻底消失', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.secureNote, name: '2.hard|delete|test', notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 }, fields: null, passwordHistory: null,
    });
    await hardDeleteCipher(http, created.id);
    const r = await sync(http, token);
    expect(r.ciphers.some((c) => c.id === created.id)).toBe(false);
  });

  it('错误的 masterPasswordHash 被拒绝为 auth 错误', async () => {
    const bare = new HttpClient({ baseUrl: BASE });
    await expect(loginWithPassword(bare, {
      email: EMAIL, masterPasswordHash: 'bm90LWEtaGFzaA==', device,
    })).rejects.toMatchObject({ kind: 'auth' });
  });
});
```

- [ ] **Step 4: 运行契约测试**

```bash
./scripts/dev-server.sh start
bun run seed
bun run test:contract
```
Expected: 全部 PASS。**任何失败都说明我们对协议的理解有误，必须查清再继续。**

- [ ] **Step 5: 确认单元测试仍全绿且不需要网络**

```bash
bun run test && bun run typecheck
```
Expected: 全绿。把 `dev-server.sh stop` 停掉后再跑一次 `bun run test`，应仍然全绿 —— 单元测试不得依赖网络。

- [ ] **Step 6: Commit**

```bash
git add packages/api vitest.config.ts vitest.contract.config.ts package.json
git commit -m "test(api): add live contract tests against a real Vaultwarden"
```

---

## 完成标准

- [ ] `bun run test` 全绿，且**在服务器停止时也全绿**（单元测试零网络依赖）
- [ ] `bun run typecheck` 无错误
- [ ] `bun run test:contract` 对真实 Vaultwarden 全绿
- [ ] `grep -rn "onewarden/crypto" packages/api/src --include=*.ts | grep -v test` 无输出
      （API 层不得依赖密码学层）
- [ ] `grep -rniE "console\.(log|debug|info)" packages/api/src` 无输出
- [ ] 软删除/硬删除的动词有专门测试钉死（本计划唯一能造成不可逆损失的代码）

**下一份计划**：计划 3 —— `@1warden/vault`（领域层：DTO↔领域模型映射与解密、会话状态机、同步引擎、搜索、Watchtower）。
