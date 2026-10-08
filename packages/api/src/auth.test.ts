import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import {
  loginWithPassword, refreshToken, loginWithApiKey, TwoFactorRequiredError, DEVICE_TYPE,
} from './auth';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const device = { type: DEVICE_TYPE.macOSCLI, identifier: 'dev-1', name: 'onewarden-test' };

const OK_TOKEN = {
  access_token: 'at', refresh_token: 'rt', expires_in: 7200,
  Key: '2.aa|bb|cc', PrivateKey: '2.dd|ee|ff', Kdf: 0, KdfIterations: 600000,
  token_type: 'Bearer', scope: 'api offline_access',
};

function respond(body: unknown, status = 200): FetchMock {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
}

function formOf(f: FetchMock, i = 0): URLSearchParams {
  return new URLSearchParams(String((f.mock.calls[i]![1] as RequestInit).body));
}

describe('loginWithPassword', () => {
  it('posts the password grant with the exact scope the server requires', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'HASH', device });

    const f = formOf(fetchImpl);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://x.test/identity/connect/token');
    expect(f.get('grant_type')).toBe('password');
    expect(f.get('username')).toBe('a@b.com');
    expect(f.get('password')).toBe('HASH');
    // scope 必须**精确**等于这个值
    expect(f.get('scope')).toBe('api offline_access');
    expect(f.get('deviceType')).toBe(String(DEVICE_TYPE.macOSCLI));
    expect(f.get('deviceIdentifier')).toBe('dev-1');
  });

  // ⚠️ 回归测试：client_id 在 password grant 里标识**客户端应用**，
  // 而在 client_credentials 里它就是**凭据本身**。曾把两者混用一个共用的
  // deviceFields()，导致 API Key 登录的用户 ID 被 'cli' 静默覆盖 ——
  // 请求发得出去，服务端只说认证失败，看不出真正原因。
  it('sends client_id=cli for the password grant', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
    expect(formOf(fetchImpl).get('client_id')).toBe('cli');
  });

  it('trims the email before sending (server trims on its side too)', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, { email: '  a@b.com  ', masterPasswordHash: 'H', device });
    expect(formOf(fetchImpl).get('username')).toBe('a@b.com');
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
    const { Key: _omit, ...withoutKey } = OK_TOKEN;
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond(withoutKey) });
    const tok = await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
    expect(tok.key).toBeUndefined();
  });

  it('treats an explicit null Key as absent too', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl: respond({ ...OK_TOKEN, Key: null }),
    });
    expect((await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device })).key)
      .toBeUndefined();
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

  it('omits the 2FA fields entirely on a plain login', async () => {
    const fetchImpl = respond(OK_TOKEN);
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device });
    const f = formOf(fetchImpl);
    expect(f.has('twoFactorToken')).toBe(false);
    expect(f.has('twoFactorProvider')).toBe(false);
  });

  // ⚠️ 2FA 与「密码错误」都是 400 —— 必须在按状态码分类之前先看 body
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

  it('derives providers from Providers2 when the flat array is absent', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ TwoFactorProviders2: { '0': null, '7': { challenge: 'x' } } }, 400),
    });
    await expect(loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device }))
      .rejects.toMatchObject({ providers: [0, 7] });
  });

  it('treats a 400 without TwoFactorProviders2 as a plain auth failure', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ message: 'Username or password is incorrect. Try again' }, 400),
    });
    await expect(loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'bad', device }))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('treats an empty TwoFactorProviders2 as a plain auth failure', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ message: 'nope', TwoFactorProviders2: {} }, 400),
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

  it('throws malformedResponse when access_token is missing from a 200', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl: respond({ expires_in: 7200, token_type: 'Bearer' }),
    });
    await expect(loginWithPassword(http, { email: 'a@b.com', masterPasswordHash: 'H', device }))
      .rejects.toMatchObject({ kind: 'malformedResponse' });
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
    expect(f.has('username')).toBe(false);
    expect(tok.accessToken).toBe('at2');
  });

  it('surfaces invalid_grant as an auth error (the caller must re-login)', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl: respond({ error: 'invalid_grant' }, 400),
    });
    await expect(refreshToken(http, { refreshToken: 'stale', device }))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  // 刷新响应里没有 Key / PrivateKey —— 类型上必须允许缺失
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

  it('uses the organization scope for an organization.<uuid> client id', async () => {
    const fetchImpl = respond({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await loginWithApiKey(http, { clientId: 'organization.xyz', clientSecret: 's', device });
    expect(formOf(fetchImpl).get('scope')).toBe('api.organization');
  });
});
