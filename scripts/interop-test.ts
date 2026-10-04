#!/usr/bin/env bun
/**
 * 互操作测试：证明 @coffer/crypto 与官方 Bitwarden 实现字节级兼容。
 *
 * ⚠️ 这是整个计划里最重要的一个测试。
 *
 * 经源码核实，**Vaultwarden 服务端完全不实现客户端密码学** —— 它把用户密钥、
 * 私钥、所有密文都当作不透明字符串存储转发，从不解析 EncString、不做 MAC 校验、
 * 不做长度检查。也就是说**我们即使加密写错，服务端也会静默接受**，
 * 直到用户某天发现密码解不开。服务端提供的是**零验证**。
 *
 * 因此官方 CLI 是唯一的裁判。本测试不过，不得进入计划 2。
 *
 * 前置：
 *   ./scripts/dev-server.sh start
 *   bun run seed                     # 用我们的 crypto 注册账户
 *   export BW_SESSION='...'          # seed 输出的会话
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  deriveMasterKey, hashMasterPassword, stretchMasterKey,
  encryptBytes, decryptBytes, decryptString, KDF_TYPE_PBKDF2,
} from '../packages/crypto/src/index';
import { toBase64, concatBytes, utf8Encode } from '../packages/crypto/src/bytes';
import type { SymmetricKey } from '../packages/crypto/src/keys';

// 默认与 scripts/dev-env.sh 保持一致（HTTPS + 自签证书：官方 CLI 拒绝明文 HTTP）
const BASE = process.env.VW_URL ?? 'https://localhost:8443';
const EMAIL = process.env.COFFER_TEST_EMAIL ?? 'coffer-test@example.com';
const PASSWORD = process.env.COFFER_TEST_PASSWORD ?? 'Test-Master-Password-123!';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

/**
 * ⚠️ prelogin 的字段大小写**在服务端之间不一致**：
 *   prelogin    → Vaultwarden 返回 **camelCase**（kdf/kdfIterations），官方返回 PascalCase
 *   token 端点  → 两者都是 **PascalCase**（Key/PrivateKey/Kdf）
 * 已对运行中的 Vaultwarden 1.37.3 实测确认。只认一种会直接读不到值，
 * 表现为「KDF 参数 undefined → 密钥全错 → 密码错误」，极难排查。
 */
async function prelogin(): Promise<{ kdf: number; iterations: number }> {
  const r = await fetch(`${BASE}/identity/accounts/prelogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  if (!r.ok) throw new Error(`prelogin 失败: ${r.status} ${await r.text()}`);
  const raw = (await r.json()) as Record<string, unknown>;
  const kdf = (raw['kdf'] ?? raw['Kdf']) as number | undefined;
  const iterations = (raw['kdfIterations'] ?? raw['KdfIterations']) as number | undefined;
  if (kdf === undefined || iterations === undefined) {
    throw new Error(`prelogin 响应缺少 KDF 字段（大小写不匹配？）：${JSON.stringify(raw)}`);
  }
  return { kdf, iterations };
}

interface TokenResponse { access_token: string; Key?: string; PrivateKey?: string; Kdf: number }

async function token(masterPasswordHash: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'password',
    username: EMAIL,
    password: masterPasswordHash,
    scope: 'api offline_access', // 必须精确等于这个值
    client_id: 'cli',
    deviceType: '24',            // 24 = macOS CLI
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'coffer-interop',
  });
  const r = await fetch(`${BASE}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  });
  if (!r.ok) throw new Error(`token 失败: ${r.status} ${await r.text()}`);
  return r.json() as Promise<TokenResponse>;
}

async function api(path: string, tok: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function jwtSub(t: string): string {
  const payload = t.split('.')[1];
  if (!payload) throw new Error('access token 不是合法 JWT');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
}

/**
 * 会话优先取环境变量，其次读 .dev/bw-session（由 scripts/seed-account.ts 写入）。
 * 缺会话时 bw 会转成**交互式提示**，在非 TTY 环境下刷屏并抛 readline 错误 —— 所以宁可提前失败。
 */
function readSession(): string {
  if (process.env.BW_SESSION) return process.env.BW_SESSION;
  try {
    return readFileSync(new URL('../.dev/bw-session', import.meta.url), 'utf8').trim();
  } catch {
    throw new Error('缺少 bw 会话 —— 请先运行 `bun run seed`');
  }
}

let session: string | undefined;
/**
 * 所有 bw 调用都必须走这里 —— 手写 execFileSync 极易漏掉 `--session`，
 * 而 bw 在缺会话时会转而**交互式索要主密码**，非 TTY 下刷屏并抛 readline 错误，
 * 报错信息还完全指不到真正的原因。
 */
function bw(args: string[]): string {
  session ??= readSession();
  return execFileSync('bw', [...args, '--session', session], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // 禁止交互：缺凭据时直接失败，而不是弹提示
    env: { ...process.env, BW_NOINTERACTION: 'true' },
  });
}

async function main() {
  console.log(`\n互操作测试 → ${BASE}\n`);

  // ── 方向 A：官方能解开我们写的 ──
  console.log('方向 A：我们的 crypto 加密 → 官方 CLI 解密');

  const { kdf, iterations } = await prelogin();
  console.log(`  服务器 KDF 参数: kdf=${kdf} iterations=${iterations}`);
  if (kdf !== KDF_TYPE_PBKDF2) throw new Error(`本测试假定 PBKDF2 账户，实际为 ${kdf}`);

  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, { kdf: KDF_TYPE_PBKDF2, iterations });
  const mpHash = await hashMasterPassword(masterKey, PASSWORD);

  let tok: TokenResponse;
  try {
    tok = await token(mpHash);
    check('用我们派生的 masterPasswordHash 通过服务端认证', true);
  } catch (e) {
    check('用我们派生的 masterPasswordHash 通过服务端认证', false, String(e));
    process.exit(1);
  }

  const stretched = await stretchMasterKey(masterKey);
  let userKey: SymmetricKey | undefined;
  try {
    if (!tok.Key) throw new Error('token 响应里没有 Key 字段');
    // ⚠️ 用户密钥是**原始 64 字节**，必须用 decryptBytes；
    // 用 decryptString 会尝试 UTF-8 解码二进制密钥而失败。
    const raw = await decryptBytes(tok.Key, stretched);
    check('解出的用户密钥是 64 字节（32 enc + 32 mac）', raw.length === 64, `实际 ${raw.length} 字节`);
    userKey = { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };
  } catch (e) {
    check('用拉伸主密钥解出用户密钥', false, String(e));
  }
  if (!userKey) { console.log('\n❌ 未解出用户密钥，无法继续\n'); process.exit(1); }
  check('用拉伸主密钥成功解出用户密钥', true);

  // 私钥是用用户密钥加密的 —— 能解开说明嵌套层级也对
  if (tok.PrivateKey) {
    try {
      const pk = await decryptBytes(tok.PrivateKey, userKey);
      check('用用户密钥解出 RSA 私钥（PKCS#8）', pk.length > 1000, `实际 ${pk.length} 字节`);
    } catch (e) {
      check('用用户密钥解出 RSA 私钥', false, String(e));
    }
  }

  // ── 写入一条我们自加密的条目，让官方 CLI 读 ──
  const secret = `interop-${Date.now()}-中文🔐`;
  const encName = await encryptBytes(utf8Encode(secret), userKey);
  check('我们的加密输出符合 type-2 EncString 格式',
    /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(encName));
  check('往返解密一致', (await decryptString(encName, userKey)) === secret);
  check('同一明文两次加密得到不同密文（IV 随机）', (await encryptBytes(utf8Encode(secret), userKey)) !== encName);

  let writtenId = '';
  try {
    const res = await api('/api/ciphers', tok.access_token, {
      method: 'POST',
      body: JSON.stringify({
        // ⚠️ encryptedFor 是必填字段，缺失会**反序列化失败**（不是校验错误）
        encryptedFor: jwtSub(tok.access_token),
        type: 1, name: encName, notes: null,
        favorite: false, reprompt: 0,
        folderId: null, organizationId: null,
        login: { username: null, password: null, totp: null, uris: [] },
        fields: null, passwordHistory: null,
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    writtenId = ((await res.json()) as { id: string }).id;
    check('通过 REST 写入一条自加密条目', !!writtenId);
  } catch (e) {
    check('通过 REST 写入一条自加密条目', false, String(e));
  }

  if (writtenId) {
    try {
      bw(['sync', '--force']);
      const name = (JSON.parse(bw(['get', 'item', writtenId, '--raw'])) as { name: string }).name;
      check('🔑 官方 CLI 能解出我们加密的条目名', name === secret, `CLI 解出: ${JSON.stringify(name)}`);
    } catch (e) {
      check('🔑 官方 CLI 能解出我们加密的条目名', false, String(e));
    }
  }

  // ── 方向 B：我们能解开官方写的 ──
  console.log('\n方向 B：官方 CLI 加密 → 我们的 crypto 解密');

  const bwSecret = `from-cli-${Date.now()}-中文🔐`;
  try {
    // ⚠️ `bw create item` 要求把 JSON 以 **base64 编码后作为参数**传入。
    // 从 stdin 喂原始 JSON 会报 "Error parsing the encoded request data."
    const payload = Buffer.from(JSON.stringify({
      type: 1,
      name: bwSecret,
      notes: null,
      favorite: false,
      login: { username: 'someone@example.com', password: 'pw-from-cli', totp: null, uris: [] },
    })).toString('base64');
    const out = bw(['create', 'item', payload, '--raw']);
    const cliId = (JSON.parse(out) as { id: string }).id;

    const syncRes = await api('/api/sync?excludeDomains=true', tok.access_token);
    if (!syncRes.ok) throw new Error(`sync 失败 ${syncRes.status}: ${await syncRes.text()}`);
    const sync = (await syncRes.json()) as {
      ciphers: Array<{ id: string; name: string; login?: { username?: string; password?: string } }>;
    };

    const found = sync.ciphers.find((c) => c.id === cliId);
    check('在我们拉取的 sync 里找到 CLI 写入的条目', !!found);

    if (found) {
      const decName = await decryptString(found.name, userKey);
      check('🔑 我们能解出官方 CLI 加密的条目名', decName === bwSecret, `我们解出: ${JSON.stringify(decName)}`);
      if (found.login?.username && found.login.password) {
        const u = await decryptString(found.login.username, userKey);
        const p = await decryptString(found.login.password, userKey);
        check('我们能解出 CLI 加密的用户名与密码', u === 'someone@example.com' && p === 'pw-from-cli',
          `解出 username=${JSON.stringify(u)} password=${JSON.stringify(p)}`);
      } else {
        check('CLI 写入的条目带 login 字段', false, JSON.stringify(found.login));
      }
    }
  } catch (e) {
    check('方向 B 全流程', false, String(e));
  }

  console.log(failures === 0
    ? '\n✅ 互操作测试全部通过 —— 我们的密码学与官方实现字节级兼容\n'
    : `\n❌ ${failures} 项失败 —— 不得进入计划 2\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
