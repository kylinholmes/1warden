import { describe, it, expect } from 'vitest';
import {
  urlOf, headersOf, bodyOf, toNativeRequest, toResponse, toTransportError, TransportError,
} from './transport';

describe('urlOf', () => {
  it('accepts a string, a URL and a Request', () => {
    expect(urlOf('https://a.test/x')).toBe('https://a.test/x');
    expect(urlOf(new URL('https://a.test/x'))).toBe('https://a.test/x');
    expect(urlOf(new Request('https://a.test/x'))).toBe('https://a.test/x');
  });
});

describe('headersOf', () => {
  it('reads a plain object, a Headers instance and an array of pairs', () => {
    expect(headersOf('https://a.test', { headers: { 'X-A': '1' } })).toEqual({ 'x-a': '1' });
    expect(headersOf('https://a.test', { headers: new Headers({ 'X-A': '1' }) })).toEqual({ 'x-a': '1' });
    expect(headersOf('https://a.test', { headers: [['X-A', '1']] })).toEqual({ 'x-a': '1' });
  });

  it('is empty when no headers are given', () => {
    expect(headersOf('https://a.test')).toEqual({});
  });

  // init 覆盖 Request 自带的头 —— 与 fetch 的语义一致
  it('prefers init headers over the Request headers', () => {
    const req = new Request('https://a.test', { headers: { 'X-A': 'from-request' } });
    expect(headersOf(req, { headers: { 'X-A': 'from-init' } })).toEqual({ 'x-a': 'from-init' });
  });
});

describe('bodyOf', () => {
  it('passes a string through untouched', async () => {
    expect(await bodyOf('https://a.test', { body: '{"a":1}', method: 'POST' })).toBe('{"a":1}');
  });

  it('is undefined when there is no body', async () => {
    expect(await bodyOf('https://a.test')).toBeUndefined();
  });

  it('serialises URLSearchParams the way a form post would', async () => {
    expect(await bodyOf('https://a.test', { body: new URLSearchParams({ a: '1', b: '2' }) })).toBe('a=1&b=2');
  });
});

/**
 * ⚠️ **二进制体必须走 base64，不能拿 TextDecoder 转字符串。**
 *
 * 早先这里对 `ArrayBuffer` / 类型化数组做的是 `new TextDecoder().decode(raw)` ——
 * 那不是「转错」，是**静默改字节**：不合法的 UTF-8 序列会被替换成 U+FFFD。
 * 附件上传走的就是这条路，传上去的文件会损坏，
 * 而**上传会成功** —— 用户要等下载回来才发现。
 *
 * Tauri 的 IPC 本身就是 JSON，二进制只能编码过去。
 * 用一个**独立字段**而不是在字符串前面加魔法前缀：前缀要靠双方都记得检查，
 * 而独立字段是类型层面的区分，忘了处理会直接是 undefined。
 */
describe('toNativeRequest —— 二进制体', () => {
  const bytes = new Uint8Array([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
  const b64 = btoa(String.fromCharCode(...bytes));

  it('base64-encodes an ArrayBuffer instead of mangling it', async () => {
    const req = await toNativeRequest('https://a.test', { method: 'POST', body: bytes.buffer.slice(0) as ArrayBuffer });
    expect(req.bodyBase64).toBe(b64);
    expect(req.body).toBeUndefined();
  });

  it('base64-encodes a typed array', async () => {
    expect((await toNativeRequest('https://a.test', { method: 'POST', body: bytes })).bodyBase64).toBe(b64);
  });

  it('base64-encodes a Blob', async () => {
    expect((await toNativeRequest('https://a.test', { method: 'POST', body: new Blob([bytes as BlobPart]) })).bodyBase64).toBe(b64);
  });

  /** 文本路径不能被碰到 —— 绝大多数请求走的是它 */
  it('still sends a plain string as text', async () => {
    const req = await toNativeRequest('https://a.test', { method: 'POST', body: '{"a":1}' });
    expect(req.body).toBe('{"a":1}');
    expect(req.bodyBase64).toBeUndefined();
  });

  /** 中文是多字节但**合法** UTF-8 —— 该按文本走，不是 base64 */
  it('keeps valid UTF-8 text in a Blob as text', async () => {
    expect((await toNativeRequest('https://a.test', { method: 'POST', body: new Blob(['中文']) })).body).toBe('中文');
  });

  /** 0x89 是 PNG 的魔数首字节，在 UTF-8 里非法 —— 必须走 base64 才不会被改 */
  it('does not let a binary body survive as text', async () => {
    const req = await toNativeRequest('https://a.test', { method: 'POST', body: bytes });
    expect(req.body).toBeUndefined();
  });
});

describe('toNativeRequest', () => {
  it('carries redirect mode from RequestInit and Request while retaining the fetch default', async () => {
    expect((await toNativeRequest('https://a.test', { redirect: 'error' }))).toHaveProperty('redirect', 'error');
    const request = new Request('https://a.test', { redirect: 'manual' });
    expect(await toNativeRequest(request)).toHaveProperty('redirect', 'manual');
    expect(await toNativeRequest(request, { redirect: 'follow' })).toHaveProperty('redirect', 'follow');
    expect(await toNativeRequest('https://a.test')).toHaveProperty('redirect', 'follow');
  });

  it('uppercases the method and defaults to GET', async () => {
    expect((await toNativeRequest('https://a.test', { method: 'post' })).method).toBe('POST');
    expect((await toNativeRequest('https://a.test')).method).toBe('GET');
  });

  /**
   * 无 body 时必须**不出现** body 字段。serde 的 `Option<String>` 收到
   * `null` 与收到字段缺失行为不同 —— 前者会被当成显式传了 null。
   */
  it('omits the body key entirely when there is no body', async () => {
    expect('body' in (await toNativeRequest('https://a.test', { method: 'GET' }))).toBe(false);
  });

  it('carries the body through when there is one', async () => {
    const req = await toNativeRequest('https://a.test', { method: 'POST', body: 'x=1' });
    expect(req.body).toBe('x=1');
  });
});

describe('toResponse', () => {
  it('rebuilds status, headers and body', async () => {
    const res = toResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  /**
   * 204/205/304 按规范不允许带响应体，`new Response('', {status:204})` 会抛
   * TypeError。Vaultwarden 的删除接口就返回 204 —— 不许在这里炸掉。
   */
  it('does not throw on null-body statuses', () => {
    expect(() => toResponse({ status: 204, headers: {}, body: '' })).not.toThrow();
    expect(toResponse({ status: 204, headers: {}, body: '' }).status).toBe(204);
  });

  /**
   * `new Response()` 的 header guard 是 "response"，而 `Set-Cookie` 是它唯一
   * 禁止的名字 —— 在 WebKit（也就是 App 真正跑的引擎）里设置它会抛 TypeError。
   *
   * ⚠️ 断言的是**结果里不含 set-cookie**，而不是「没有抛错」：
   * 早先写成 `not.toThrow()` 时这条测试是假的 —— 当时 `headers.set` 外面
   * 本来就有 try/catch，把显式跳过整段删掉它照样通过（变异检验抓到的）。
   */
  it('never lets set-cookie reach the resulting Response', () => {
    const res = toResponse({
      status: 200, headers: { 'set-cookie': 'a=b', 'content-type': 'text/plain' }, body: 'ok',
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    // 其余响应头不受牵连
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.status).toBe(200);
  });

  /**
   * ⚠️ **二进制响应体必须一个字节不差地还原。**
   *
   * Rust 侧从 `res.bytes()` 取字节，非 UTF-8 的走 `bodyBase64` 回来。
   * 前端这一半如果只认 `body`，二进制就会变成**空响应** —— 下载的附件
   * 是坏的、图标是空的，而状态码是 200，看起来一切正常。
   */
  it('restores a base64 body as the original bytes', async () => {
    // PNG 魔数：0x89 不是合法 UTF-8 首字节，正是会被有损解码改掉的那类
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    let bin = '';
    for (const b of png) bin += String.fromCharCode(b);

    const res = toResponse({ status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: btoa(bin) });

    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]);
  });

  /** 文本那一半不受影响 */
  it('still prefers the text body when there is one', async () => {
    const res = toResponse({ status: 200, headers: {}, body: '{"a":1}' });
    expect(await res.json()).toEqual({ a: 1 });
  });
});

describe('toTransportError', () => {
  it('keeps the kind and fingerprint from the Rust side', () => {
    const e = toTransportError({ kind: 'certUntrusted', message: '证书无法验证', fingerprint: 'AB:CD' });
    expect(e).toBeInstanceOf(TransportError);
    expect(e.kind).toBe('certUntrusted');
    expect(e.fingerprint).toBe('AB:CD');
    expect(e.message).toBe('证书无法验证');
  });

  it('keeps timeout distinct from network', () => {
    expect(toTransportError({ kind: 'timeout', message: '超时' }).kind).toBe('timeout');
  });

  /**
   * `invoke` 在命令本身失败时给的是字符串（未注册、参数反序列化失败）。
   * 那种情况必须退化成 network —— 否则会漏出一个界面上不存在的 kind。
   */
  it('falls back to network for a non-HttpError payload', () => {
    expect(toTransportError('command not found').kind).toBe('network');
    expect(toTransportError({ nope: true }).kind).toBe('network');
    expect(toTransportError(null).kind).toBe('network');
    expect(toTransportError(undefined).kind).toBe('network');
  });
});
