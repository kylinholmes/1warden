import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 直接以 `typeof fetch` 为签名 —— 自定义签名（如 `url: string`）与真实的
 * fetch 不兼容（它接受 `URL | RequestInfo`），赋值时会被 TS 拒绝。
 * mock.calls 也因此有了正确的元组类型，可以取到 [0]/[1]。
 */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const mockFetch = (fn: typeof fetch): FetchMock => vi.fn(fn);

function callOf(f: FetchMock, i = 0): { url: string; init: RequestInit } {
  const c = f.mock.calls[i]!;
  return { url: String(c[0]), init: c[1] ?? {} };
}

describe('HttpClient', () => {
  it('GETs and parses JSON', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await http.request('GET', '/api/config')).toEqual({ ok: true });
    expect(callOf(fetchImpl).url).toBe('https://x.test/api/config');
  });

  it('joins baseUrl and path without doubling slashes', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://x.test/', fetchImpl });
    await http.request('GET', '/api/config');
    expect(callOf(fetchImpl).url).toBe('https://x.test/api/config');
  });

  it('sends a form body with the urlencoded content type', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await http.request('POST', '/identity/connect/token', { form: { grant_type: 'password' } });
    const { init } = callOf(fetchImpl);
    expect((init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded; charset=utf-8');
    expect(String(init.body)).toBe('grant_type=password');
  });

  it('attaches caller-supplied headers', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl, headers: () => ({ Authorization: 'Bearer t' }),
    });
    await http.request('GET', '/api/sync');
    expect((callOf(fetchImpl).init.headers as Record<string, string>)['Authorization']).toBe('Bearer t');
  });

  it('returns undefined for a 204 with no body', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await http.request('POST', '/api/x')).toBeUndefined();
  });

  it('throws ApiError(network) when fetch rejects', async () => {
    const fetchImpl = mockFetch(async () => { throw new TypeError('Failed to fetch'); });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws ApiError(timeout) when the request exceeds timeoutMs', async () => {
    const fetchImpl = mockFetch((_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl, timeoutMs: 10 });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws ApiError(malformedResponse) when a 200 body is not JSON', async () => {
    const fetchImpl = mockFetch(async () => new Response('<html>nope</html>', { status: 200 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('classifies a non-2xx status and keeps the parsed body', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ message: 'Username or password is incorrect' }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('POST', '/identity/connect/token')).rejects.toMatchObject({
      kind: 'auth', status: 400,
    });
  });

  // Vaultwarden 的 401 是纯文本（认证守卫失败），不是 JSON
  it('handles a plain-text error body without throwing a parse error', async () => {
    const fetchImpl = mockFetch(async () => new Response('Invalid claim', { status: 401 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/api/sync')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('lets a caller read the raw Response (needed for 2FA detection)', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ TwoFactorProviders: ['0'] }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    const res = await http.requestRaw('POST', '/identity/connect/token', { allowErrorStatus: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ TwoFactorProviders: ['0'] });
  });

  // 2FA 与「密码错误」都是 400，必须在按状态码分类之前先看 body
  it('throws by default on an error status, but not when allowErrorStatus is set', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ message: 'nope' }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.requestRaw('POST', '/x')).rejects.toMatchObject({ kind: 'auth' });
    await expect(http.requestRaw('POST', '/x', { allowErrorStatus: true })).resolves.toBeInstanceOf(Response);
  });

  it('does not put secrets into the error message', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ message: 'bad 2.AAAA|BBBB|CCCC' }, 400));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/x')).rejects.toThrow(/^(?!.*2\.).*$/);
  });

  /**
   * 桌面端的传输层（Rust 侧）会自己给错误分类。它比这里更清楚发生了什么 ——
   * 比如「服务器证书无法验证」根本不是一个网络故障，压成 `network` 之后
   * 界面就只能说「连不上服务器」，用户永远不知道该去信任证书。
   */
  it('preserves a transport-classified kind instead of flattening it to network', async () => {
    const fromTransport = Object.assign(new Error('vault.example.com 的证书无法验证'), {
      kind: 'certUntrusted',
      fingerprint: 'AB:CD:EF',
    });
    const fetchImpl = mockFetch(async () => { throw fromTransport; });
    const http = new HttpClient({ baseUrl: 'https://self-hosted.test', fetchImpl });
    await expect(http.request('GET', '/api/config')).rejects.toMatchObject({
      kind: 'certUntrusted',
      fingerprint: 'AB:CD:EF',
    });
  });

  // 分类得由传输层说了算 —— 但它不能凭空造出一个这里不认识的类别
  it('ignores an unknown kind from the transport and falls back to network', async () => {
    const fetchImpl = mockFetch(async () => {
      throw Object.assign(new Error('boom'), { kind: 'somethingElse' });
    });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ kind: 'network' });
  });

  // AbortError 仍然要优先判成超时 —— 传输层不该影响这条既有规则
  it('still reports timeout for an AbortError even if the transport attached a kind', async () => {
    const fetchImpl = mockFetch(async () => {
      throw Object.assign(new DOMException('Aborted', 'AbortError'), { kind: 'certUntrusted' });
    });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ kind: 'timeout' });
  });
});
