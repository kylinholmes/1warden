import { ApiError, classifyStatus, messageFor } from './errors';
import { safeBody, type HttpClient } from './http';

/** Vaultwarden verification-token registration, shared with its bundled Bitwarden web vault. */
export type RegistrationStep = { kind: 'verifyEmail' } | { kind: 'setPassword'; token: string };
export interface RegistrationKeys {
  masterPasswordHash: string;
  key: string;
  keys: { publicKey: string; encryptedPrivateKey: string };
  kdfType: 0;
  kdfIterations: number;
  kdfMemory: null;
  kdfParallelism: null;
}
export interface RegistrationRequest extends RegistrationKeys {
  email: string;
  emailVerificationToken: string;
  masterPasswordHint: string | null;
}

export function registrationServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的服务器地址，例如 https://vault.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('服务器地址须为 HTTP 或 HTTPS 网址，且不含登录凭据、查询参数或页面片段');
  }
  return url.href.replace(/\/+$/, '');
}

async function registrationResponse(http: HttpClient, path: string, json: unknown): Promise<Response> {
  const res = await http.requestRaw('POST', `/identity/accounts/register/${path}`, { json, allowErrorStatus: true });
  if (res.ok) return res;
  const body = await safeBody(res);
  const message = messageFor(body);
  const translated = /Registration not allowed or user already exists/i.test(message)
    ? '服务器未开放注册或该邮箱已注册。已有账户请登录；需要新账户请联系管理员。'
    : res.status === 404 || res.status === 405
      ? '此服务器不支持当前注册流程，请在服务器网页中注册后返回登录。'
      : message;
  throw new ApiError(classifyStatus(res.status), translated, { status: res.status });
}

export async function beginRegistration(http: HttpClient, fields: { email: string; name: string }): Promise<RegistrationStep> {
  const res = await registrationResponse(http, 'send-verification-email', {
    email: fields.email.trim().toLowerCase(), name: fields.name.trim(),
  });
  // The server intentionally returns the same 204 for an already registered
  // address. The UI must not promise that an email or an account was created.
  if (res.status === 204) return { kind: 'verifyEmail' };
  const body = await safeBody(res);
  if (typeof body !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.trim())) {
    throw new ApiError('malformedResponse', '服务器未返回有效的注册令牌');
  }
  return { kind: 'setPassword', token: body.trim() };
}

export async function finishRegistration(http: HttpClient, payload: RegistrationRequest): Promise<void> {
  const res = await registrationResponse(http, 'finish', payload);
  const body = await safeBody(res);
  const object = body && typeof body === 'object' ? (body as Record<string, unknown>)['object'] : undefined;
  // 1.37.3 calls this "register"; 1.37.4 renamed only the response object.
  if (object !== 'registerFinish' && object !== 'register') {
    throw new ApiError('malformedResponse', '服务器未确认账户注册，请在服务器网页中确认后登录');
  }
}
