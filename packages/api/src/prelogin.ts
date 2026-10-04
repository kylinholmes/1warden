import { ApiError } from './errors';
import type { HttpClient } from './http';

export interface ServerEnvironment {
  vault: string | undefined;
  api: string | undefined;
  identity: string | undefined;
  notifications: string | undefined;
  icons: string | undefined;
  events: string | undefined;
}

export interface ServerConfig {
  version: string;
  serverName: string;
  environment: ServerEnvironment;
  disableUserRegistration: boolean | undefined;
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

/** 只有真正的有限数字才算数 —— null / 字符串 / NaN 一律当作「缺失」 */
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * 读取服务器配置。
 *
 * `version` 是 Vaultwarden **模拟的 Bitwarden 服务端版本**（如 "2026.6.0"），
 * 不是 Vaultwarden 自身版本。
 *
 * ⚠️ 按接口稳定性原则，`version` **只用于能力探测，绝不用于拒绝服务** ——
 * 遇到不认识的版本应当继续尝试，而不是拒绝连接。
 */
export async function getServerConfig(http: HttpClient): Promise<ServerConfig> {
  const raw = await http.request<unknown>('GET', '/api/config');
  const root = asRecord(raw);
  const server = asRecord(root['server']);
  const env = asRecord(root['environment']);
  const settings = asRecord(root['settings']);

  const registration = settings['disableUserRegistration'];

  return {
    version: asString(root['version']) ?? 'unknown',
    serverName: asString(server['name']) ?? 'unknown',
    environment: {
      vault: asString(env['vault']),
      api: asString(env['api']),
      identity: asString(env['identity']),
      notifications: asString(env['notifications']),
      icons: asString(env['icons']),
      events: asString(env['events']),
    },
    disableUserRegistration: typeof registration === 'boolean' ? registration : undefined,
  };
}

/**
 * 取回该邮箱的 KDF 参数。
 *
 * ⚠️ **字段大小写在不同服务端之间不一致**：
 *   - prelogin   → Vaultwarden 返回 **camelCase**（`kdf`/`kdfIterations`）
 *                  官方服务端返回 PascalCase
 *   - token 端点 → 两者都返回 **PascalCase**（`Key`/`PrivateKey`/`Kdf`）
 *
 * 已对运行中的 Vaultwarden 1.37.3 实测确认。两种都吃。
 *
 * 只认一种大小写会得到 `undefined`，然后被拿去派生出一整套错误的密钥，
 * 最终表现为「用户名或密码错误」—— 没有任何线索指向大小写。
 * 因此这里宁可**响亮地失败**，也不返回一个字段缺失的结果。
 */
export async function prelogin(http: HttpClient, email: string): Promise<PreloginResult> {
  const raw = await http.request<unknown>('POST', '/identity/accounts/prelogin', {
    json: { email },
  });
  const root = asRecord(raw);

  const kdf = asNumber(pick(root, 'kdf', 'Kdf'));
  const iterations = asNumber(pick(root, 'kdfIterations', 'KdfIterations'));

  if (kdf === undefined || iterations === undefined) {
    throw new ApiError('malformedResponse', '服务器没有返回 KDF 参数', { body: raw });
  }
  if (kdf !== 0 && kdf !== 1) {
    throw new ApiError('malformedResponse', `不支持的 KDF 类型：${kdf}`, { body: raw });
  }

  return {
    kdf,
    iterations,
    memory: asNumber(pick(root, 'kdfMemory', 'KdfMemory')),
    parallelism: asNumber(pick(root, 'kdfParallelism', 'KdfParallelism')),
  };
}
