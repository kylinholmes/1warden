import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { prelogin, getServerConfig } from './prelogin';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function respond(body: unknown, status = 200): FetchMock {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
}

describe('prelogin', () => {
  // Vaultwarden 1.37.3 的真实响应（已实测确认）
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
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://x.test/identity/accounts/prelogin');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({ email: 'a@b.com' });
  });

  // 读不到值时必须响亮失败，而不是让 undefined 一路传到密钥派生里，
  // 最终表现为「密码错误」—— 完全指不到真正的原因
  it('throws malformedResponse when the KDF fields are missing entirely', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ salt: null }) });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('rejects an unknown kdf type number', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ kdf: 99, kdfIterations: 1 }) });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('treats an explicit null iteration count as missing', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ kdf: 0, kdfIterations: null }) });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  // 容错性：服务端加字段不该影响我们
  it('ignores unknown extra fields', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ kdf: 0, kdfIterations: 600000, somethingNew: { nested: true } }),
    });
    expect((await prelogin(http, 'a@b.com')).iterations).toBe(600000);
  });

  it('propagates a rateLimited error rather than masking it', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ message: 'Too many requests' }, 429),
    });
    await expect(prelogin(http, 'a@b.com')).rejects.toMatchObject({ kind: 'rateLimited' });
  });
});

describe('getServerConfig', () => {
  it('parses the Vaultwarden config shape', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({
        version: '2026.6.0',
        server: { name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden' },
        environment: {
          vault: 'https://x.test', api: 'https://x.test/api',
          identity: 'https://x.test/identity', notifications: 'https://x.test/notifications',
        },
        settings: { disableUserRegistration: false },
      }),
    });
    const cfg = await getServerConfig(http);
    expect(cfg.version).toBe('2026.6.0');
    expect(cfg.serverName).toBe('Vaultwarden');
    expect(cfg.environment.identity).toBe('https://x.test/identity');
    expect(cfg.disableUserRegistration).toBe(false);
  });

  it('tolerates a config with no environment block', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ version: '1', server: { name: 'X' } }),
    });
    const cfg = await getServerConfig(http);
    expect(cfg.environment.identity).toBeUndefined();
  });

  it('tolerates a config with no server block at all', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({}) });
    const cfg = await getServerConfig(http);
    expect(cfg.serverName).toBe('unknown');
    expect(cfg.version).toBe('unknown');
  });
});
