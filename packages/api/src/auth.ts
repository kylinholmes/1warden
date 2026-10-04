import { ApiError, classifyStatus, messageFor } from './errors';
import type { HttpClient } from './http';
import { safeBody } from './http';

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

/**
 * ⚠️ 这里**不含 `client_id`**。
 *
 * `client_id` 在两种 grant 里含义完全不同：
 *   - password / refresh_token → 标识**客户端应用**（我们发 `cli`）
 *   - client_credentials       → 它**就是凭据本身**（`user.<uuid>`）
 *
 * 把它放进这个共用函数会覆盖掉 API Key 登录时传进来的用户 ID，
 * 且**静默失败**：请求发得出去、服务端只是说认证失败，看不出真正原因。
 */
function deviceFields(device: DeviceInfo): Record<string, string> {
  return {
    deviceType: String(device.type),
    deviceIdentifier: device.identifier,
    deviceName: device.name,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toTokenResponse(raw: unknown): TokenResponse {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const accessToken = asString(r['access_token']);
  if (accessToken === undefined) {
    throw new ApiError('malformedResponse', '认证响应里没有 access_token', { body: raw });
  }
  return {
    accessToken,
    refreshToken: asString(r['refresh_token']),
    expiresIn: typeof r['expires_in'] === 'number' && Number.isFinite(r['expires_in']) ? r['expires_in'] : 0,
    // ⚠️ Key 在服务端为空时**整个字段缺失**
    key: asString(r['Key']),
    privateKey: asString(r['PrivateKey']),
    kdf: typeof r['Kdf'] === 'number' ? r['Kdf'] : undefined,
  };
}

/**
 * 判定响应是否为「需要 2FA」。
 *
 * 依据是**两个条件同时成立**：状态码 400 **且** body 里有非空的 `TwoFactorProviders2`。
 * 只看状态码不行 —— 密码错误也是 400。
 */
export function twoFactorFrom(res: Response, body: unknown): TwoFactorRequiredError | undefined {
  if (res.status !== 400 || body === null || typeof body !== 'object') return undefined;

  const root = body as Record<string, unknown>;
  const info = root['TwoFactorProviders2'];
  if (info === null || typeof info !== 'object' || Object.keys(info as object).length === 0) {
    return undefined;
  }

  const providersInfo = info as Record<string, unknown>;
  const flat = root['TwoFactorProviders'];
  const providers = Array.isArray(flat)
    ? flat.map((p) => Number(p)).filter((n) => Number.isInteger(n))
    : Object.keys(providersInfo).map((k) => Number(k)).filter((n) => Number.isInteger(n));

  return new TwoFactorRequiredError(providers, providersInfo, body);
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
    client_id: 'cli',
    username: p.email.trim(), // 服务端也会 trim，两边一致
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

  // 必须用 allowErrorStatus：2FA 与「密码错误」都是 400，
  // 先抛错就再也分辨不出是哪种
  const res = await http.requestRaw('POST', '/identity/connect/token', { form, allowErrorStatus: true });
  const body = await safeBody(res);

  if (!res.ok) {
    const tfa = twoFactorFrom(res, body);
    if (tfa) throw tfa;
    throw new ApiError(classifyStatus(res.status), messageFor(body), { status: res.status, body });
  }
  return toTokenResponse(body);
}

export async function refreshToken(
  http: HttpClient,
  p: { refreshToken: string; device: DeviceInfo },
): Promise<TokenResponse> {
  const raw = await http.request<unknown>('POST', '/identity/connect/token', {
    form: {
      grant_type: 'refresh_token',
      client_id: 'cli',
      refresh_token: p.refreshToken,
      ...deviceFields(p.device),
    },
  });
  return toTokenResponse(raw);
}

/**
 * 用个人 API Key 登录（`client_id` = `user.<uuid>`）。
 *
 * ⚠️ 这条路径**绕过 2FA** —— 服务端不做二次验证。
 * 因此拿到 API Key 等同于拿到账户访问权，UI 上要把它当敏感凭据对待。
 */
export async function loginWithApiKey(
  http: HttpClient,
  p: { clientId: string; clientSecret: string; device: DeviceInfo },
): Promise<TokenResponse> {
  const scope = p.clientId.startsWith('organization.') ? 'api.organization' : 'api';
  const raw = await http.request<unknown>('POST', '/identity/connect/token', {
    form: {
      grant_type: 'client_credentials',
      client_id: p.clientId,
      client_secret: p.clientSecret,
      scope,
      ...deviceFields(p.device),
    },
  });
  return toTokenResponse(raw);
}
