/**
 * 一个够用的假 Vaultwarden —— 只实现连接流程真正会碰到的那几个端点。
 *
 * 存在的理由：`VaultClient.connect` 是整个应用最容易出错的编排点
 * （KDF → 登录 → 解用户密钥 → 同步 → 解锁），而它此前**完全没有测试**。
 * 结果就是一个只有跑起真实 App 才暴露的 bug：登录成功、同步成功，
 * 最后一步却抛「completeUnlock 只能在 unlocking 状态调用」。
 *
 * 图形界面的回路一次要几十秒，还依赖窗口焦点；这里只要几十毫秒。
 */
import type { SymmetricKey } from '@1warden/crypto';
import { concatBytes, encryptBytes } from '@1warden/crypto';

export interface FakeServerOptions {
  /** 服务端要返回的用户密钥（明文 64 字节）。测试用它验证客户端解得对不对。 */
  userKey: SymmetricKey;
  /** 客户端用来解用户密钥的拉伸主密钥 —— 必须和客户端派生出的那把一致 */
  stretchedMasterKey: SymmetricKey;
  kdfIterations?: number;
  /** 覆盖某个端点，用来制造失败场景 */
  override?: (path: string, init: RequestInit | undefined) => Response | undefined;
}

export interface FakeServer {
  fetchImpl: typeof fetch;
  /** 依次记录收到的 `METHOD /path`，用来断言请求确实发出去了 */
  calls: string[];
}

/** 服务端下发的条目（密文形态）—— 由测试决定内容 */
export interface FakeCipher {
  id: string;
  type: number;
  name: string;
  [k: string]: unknown;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * 客户端只从 JWT 里取 `sub`（用户 uuid），签名不校验 ——
 * 所以这里拼一个结构正确但没有签名的 token 就够了。
 */
export function fakeJwt(sub: string): string {
  return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url({ sub })}.not-a-real-signature`;
}

export function createFakeServer(opts: FakeServerOptions): FakeServer {
  const calls: string[] = [];
  const iterations = opts.kdfIterations ?? 1000;   // 测试不需要真实的 60 万轮

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${path}`);

    const overridden = opts.override?.(path, init);
    if (overridden) return overridden;

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      });

    switch (path) {
      case '/identity/accounts/prelogin':
        // Vaultwarden 这里返回 camelCase
        return json({
          kdf: 0, kdfIterations: iterations, kdfMemory: null, kdfParallelism: null,
        });

      case '/identity/connect/token': {
        // 用户密钥是**原始 64 字节**，用拉伸主密钥加密后下发
        const raw = concatBytes(opts.userKey.encKey, opts.userKey.macKey);
        const key = await encryptBytes(raw, opts.stretchedMasterKey);
        return json({
          access_token: fakeJwt('user-0000-1111-2222-333333333333'),
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          Key: key,
          PrivateKey: null,
          Kdf: 0,
          TwoFactorToken: null,
        });
      }

      case '/api/accounts/revision-date':
        // 裸整数，不是 JSON 对象
        return new Response('1791131998281', { status: 200 });

      case '/api/sync':
        return json({
          profile: { id: 'user-0000-1111-2222-333333333333', email: 'onewarden-test@example.com' },
          folders: [],
          ciphers: [],
          collections: [],
        });

      default:
        return json({ message: `假服务器没有实现 ${path}` }, 404);
    }
  };

  return { fetchImpl, calls };
}
