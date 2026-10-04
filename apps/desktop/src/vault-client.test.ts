import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VaultClient } from './vault-client';
import { createFakeServer, fakeJwt } from './fake-server';
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
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

const KDF: KdfConfig = { kdf: KDF_TYPE_PBKDF2, iterations: ITERATIONS };

/** 造一个「服务端已有此账户」的场景：密钥派生与客户端将要做的一模一样 */
async function serverWithAccount(userKey: SymmetricKey = makeUserKey()) {
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF);
  const stretchedMasterKey = await stretchMasterKey(masterKey);
  return { server: createFakeServer({ userKey, stretchedMasterKey, kdfIterations: ITERATIONS }), userKey };
}

function clientFor(server: ReturnType<typeof createFakeServer>) {
  return new VaultClient({ fetchImpl: server.fetchImpl });
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
