import { describe, it, expect, vi } from 'vitest';
import { VaultClient } from './client';
import { createFakeServer, fakeJwt } from './testing/fake-server';
import {
  deriveMasterKey, stretchMasterKey, makeUserKey, KDF_TYPE_PBKDF2,
  type SymmetricKey, type KdfConfig,
} from '@coffer/crypto';

const EMAIL = 'coffer-test@example.com';
const PASSWORD = 'Test-Master-Password-123!';
const SERVER = 'https://vault.test';
const ITERATIONS = 1000;

/**
 * 这些测试跑在 node 环境里，没有 localStorage。
 * 设备标识要持久化，于是给它一个内存版即可 —— 顺带让测试互不影响。
 */
/** 内存版设备标识存储 —— 服务 worker 里没有 localStorage，测试也一样 */
function memoryDeviceStore() {
  let id: string | null = null;
  return {
    get: () => id,
    set: (v: string) => { id = v; },
    clear: () => { id = null; },
  };
}

const KDF: KdfConfig = { kdf: KDF_TYPE_PBKDF2, iterations: ITERATIONS };

/** 造一个「服务端已有此账户」的场景：密钥派生与客户端将要做的一模一样 */
async function serverWithAccount(userKey: SymmetricKey = makeUserKey()) {
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF);
  const stretchedMasterKey = await stretchMasterKey(masterKey);
  return { server: createFakeServer({ userKey, stretchedMasterKey, kdfIterations: ITERATIONS }), userKey };
}

function clientFor(server: ReturnType<typeof createFakeServer>) {
  return new VaultClient({ fetchImpl: server.fetchImpl, deviceStore: memoryDeviceStore() });
}

describe('VaultClient.connect —— 完整编排', () => {
  /**
   * 这是曾经真实坏掉的那条路：登录成功、同步成功，最后一步却抛
   * 「completeUnlock 只能在 unlocking 状态调用，当前是 unlocked」，
   * 用户看到的是连接成功后卡在解锁屏。
   *
   * 之所以没被测出来，是因为这个编排点此前完全没有测试 —— 只有把真实
   * App 跑起来才能发现。假服务器把它变成了几十毫秒的事。
   */
  it('walks prelogin → login → key → sync and ends unlocked', async () => {
    const { server } = await serverWithAccount();
    const client = clientFor(server);

    await client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD });

    expect(client.isUnlocked()).toBe(true);
    expect(client.getSession().status).toBe('unlocked');
    expect(server.calls).toContain('POST /identity/accounts/prelogin');
    expect(server.calls).toContain('POST /identity/connect/token');
    expect(server.calls).toContain('GET /api/sync');
  });

  it('records the account so the unlock screen can show it', async () => {
    const { server } = await serverWithAccount();
    const client = clientFor(server);
    await client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD });

    expect(client.getSession().account?.email).toBe(EMAIL);
    expect(client.getSession().account?.serverUrl).toBe(SERVER);
    // JWT 的 sub 就是用户 uuid —— 写入条目时要用它填 encryptedFor
    expect(client.getUserId()).toBe('user-0000-1111-2222-333333333333');
  });

  /**
   * 用户密钥解得对不对，只有拿它真去解一条条目才能确认。
   * 这里直接比对会话里落下的那把 key 与服务端下发的明文是否一致。
   */
  it('decrypts the user key the server sent', async () => {
    const { server, userKey } = await serverWithAccount();
    const client = clientFor(server);
    await client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD });

    const key = client.getSession().getKey();
    expect(key).not.toBeNull();
    expect(Array.from(key!.encKey)).toEqual(Array.from(userKey.encKey));
    expect(Array.from(key!.macKey)).toEqual(Array.from(userKey.macKey));
  });

  it('sends the device identity the server expects on the token request', async () => {
    const { server } = await serverWithAccount();
    let tokenBody = '';
    const wrapped = createFakeServer({
      userKey: makeUserKey(),
      stretchedMasterKey: { encKey: new Uint8Array(32), macKey: new Uint8Array(32) },
    });
    // 只关心请求体，直接拦下 token 端点
    const client = new VaultClient({
      deviceStore: memoryDeviceStore(),
      fetchImpl: async (input, init) => {
        if (String(input).includes('/identity/connect/token')) tokenBody = String(init?.body ?? '');
        return wrapped.fetchImpl(input, init);
      },
    });
    await client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD }).catch(() => {});

    expect(tokenBody).toContain('grant_type=password');
    expect(tokenBody).toContain('deviceType=');
    expect(tokenBody).toContain('deviceIdentifier=');
    // client_id 在 password grant 里标识的是**客户端应用**
    expect(tokenBody).toContain('client_id=cli');
    void server;
  });

  it('rejects when the server sends no user key', async () => {
    const server = createFakeServer({
      userKey: makeUserKey(),
      stretchedMasterKey: { encKey: new Uint8Array(32), macKey: new Uint8Array(32) },
      override: (path) => path === '/identity/connect/token'
        ? new Response(JSON.stringify({
            access_token: fakeJwt('u'), expires_in: 3600, Key: null,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : undefined,
    });
    const client = clientFor(server);

    await expect(
      client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD }),
    ).rejects.toThrow(/用户密钥/);
    expect(client.isUnlocked()).toBe(false);
  });

  it('surfaces a cert error from the transport without flattening it', async () => {
    const client = new VaultClient({
      deviceStore: memoryDeviceStore(),
      fetchImpl: async () => {
        throw Object.assign(new Error('vault.test 的证书无法验证'), {
          kind: 'certUntrusted', fingerprint: 'AB:CD',
        });
      },
    });

    await expect(
      client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD }),
    ).rejects.toMatchObject({ kind: 'certUntrusted', fingerprint: 'AB:CD' });
  });
});

describe('authentication lifetime', () => {
  it('starts a fresh sync after lock instead of waiting for the previous login', async () => {
    const { server } = await serverWithAccount();
    let started!: () => void;
    const firstSyncStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const firstSyncReady = new Promise<void>((resolve) => { release = resolve; });
    let syncRequests = 0;
    const client = new VaultClient({
      deviceStore: memoryDeviceStore(),
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/sync' && ++syncRequests === 1) { started(); await firstSyncReady; }
        return server.fetchImpl(input, init);
      },
    });
    const oldLogin = client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD });
    const oldRejection = expect(oldLogin).rejects.toThrow(/过期|锁定/);
    await firstSyncStarted;
    client.lock();
    const unlocking = client.unlock(PASSWORD);
    try {
      await vi.waitFor(() => expect(syncRequests).toBe(2), { timeout: 500 });
      await unlocking;
      expect(client.isUnlocked()).toBe(true);
    } finally {
      release();
      await Promise.all([oldRejection, unlocking]);
      client.logout();
    }
  });

  for (const operation of ['connect', 'unlock'] as const) {
  it(`completes an actual API two-factor ${operation} challenge and drops the completed credentials`, async () => {
    const { server, userKey } = await serverWithAccount();
    const client = new VaultClient({
      deviceStore: memoryDeviceStore(),
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/identity/connect/token')) {
          const form = new URLSearchParams(String(init?.body));
          if (form.get('twoFactorToken') !== '123456') {
            return Response.json({ TwoFactorProviders: [0], TwoFactorProviders2: { '0': null } }, { status: 400 });
          }
          expect(form.get('twoFactorProvider')).toBe('0');
          expect(form.get('twoFactorRemember')).toBe('1');
        }
        return server.fetchImpl(input, init);
      },
    });
    if (operation === 'unlock') client.getSession().setAccount({ serverUrl: SERVER, email: EMAIL, userId: 'test-user', kdf: KDF });
    await expect(operation === 'connect' ? client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD }) : client.unlock(PASSWORD))
      .rejects.toMatchObject({ kind: 'twoFactorRequired', providers: [0] });
    await expect(client.connectWithTwoFactor('incorrect', 0, false)).rejects.toMatchObject({ kind: 'twoFactorRequired' });
    await client.connectWithTwoFactor('123456', 0, true);
    expect(client.isUnlocked()).toBe(true);
    expect(client.getSession().getKey()?.encKey).toEqual(userKey.encKey);
    await expect(client.connectWithTwoFactor('123456', 0, false)).rejects.toThrow(/没有待完成/);
    expect(JSON.stringify(client)).not.toContain(PASSWORD);
    client.logout();
  });
  }

  for (const boundary of ['lock', 'logout'] as const) {
    it(`${boundary} discards an unfinished OTP challenge`, async () => {
      const client = new VaultClient({
        deviceStore: memoryDeviceStore(),
        fetchImpl: async (input) => String(input).includes('/prelogin')
          ? Response.json({ Kdf: 0, KdfIterations: ITERATIONS })
          : Response.json({ TwoFactorProviders: [0], TwoFactorProviders2: { '0': null } }, { status: 400 }),
      });
      await expect(client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD }))
        .rejects.toMatchObject({ kind: 'twoFactorRequired' });
      client[boundary]();
      await expect(client.connectWithTwoFactor('123456', 0, false)).rejects.toMatchObject({ kind: 'authRestartRequired' });
      expect(JSON.stringify(client)).not.toContain(PASSWORD);
    });
  }

  for (const operation of ['connect', 'unlock'] as const) {
    for (const boundary of ['lock', 'logout'] as const) {
      it(`${boundary} prevents a late ${operation} response from reopening the vault`, async () => {
        const { server } = await serverWithAccount();
        let started!: () => void;
        const tokenStarted = new Promise<void>((resolve) => { started = resolve; });
        let release!: () => void;
        const tokenReady = new Promise<void>((resolve) => { release = resolve; });
        const client = new VaultClient({
          deviceStore: memoryDeviceStore(),
          fetchImpl: async (input, init) => {
            if (String(input).endsWith('/identity/connect/token')) { started(); await tokenReady; }
            return server.fetchImpl(input, init);
          },
        });
        client.getSession().setAccount({ serverUrl: SERVER, email: EMAIL, userId: 'test-user', kdf: KDF });
        const attempt = operation === 'connect'
          ? client.connect({ serverUrl: SERVER, email: EMAIL, masterPassword: PASSWORD })
          : client.unlock(PASSWORD);
        const rejection = expect(attempt).rejects.toThrow(/过期|锁定/);
        await tokenStarted;
        client[boundary]();
        release();
        await rejection;
        expect(client.getSession().status).toBe(boundary === 'lock' ? 'locked' : 'loggedOut');
        expect(client.getSession().getKey()).toBeNull();
        expect(JSON.stringify(client)).not.toContain(PASSWORD);
      });
    }
  }

  it('keeps an incorrect unlock on the locked screen', async () => {
    const client = new VaultClient({
      deviceStore: memoryDeviceStore(),
      fetchImpl: async (input) => String(input).includes('/prelogin')
        ? Response.json({ Kdf: 0, KdfIterations: ITERATIONS })
        : Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    client.getSession().setAccount({ serverUrl: SERVER, email: EMAIL, userId: 'test-user', kdf: KDF });
    await expect(client.unlock(PASSWORD)).rejects.toThrow();
    expect(client.getSession().status).toBe('locked');
  });
});
