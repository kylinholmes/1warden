import type { TwoFactorChallenge } from '@1warden/vault';

/** Authentication copy is shared across windows; internal diagnostics stay out of forms. */
export function authenticationErrorMessage(error: unknown, context: 'login' | 'unlock' = 'unlock'): string {
  switch ((error as { kind?: string } | null)?.kind) {
    case 'auth': return context === 'login' ? '邮箱或主密码不正确' : '主密码不正确';
    case 'network': return '连不上服务器，请检查地址与网络';
    case 'timeout': return '服务器响应超时，请重试';
    case 'rateLimited': return '尝试过于频繁，请稍后再试';
    case 'certUntrusted': return '服务器证书无法验证';
    case 'malformedResponse': return '服务器响应异常，请稍后重试';
    case 'server': return '服务器出错了，请稍后重试';
    case 'authRestartRequired': return '登录已过期，请重新输入主密码';
    default: return context === 'login' ? '无法登录，请检查邮箱和主密码后重试' : '无法解锁，请检查主密码后重试';
  }
}

/** Shared by first connection and re-unlock, including errors received over RPC. */
export function twoFactorChallenge(error: unknown): TwoFactorChallenge | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as Partial<TwoFactorChallenge> & { kind?: string; twoFactorRequired?: boolean };
  if ((value.kind !== 'twoFactorRequired' && value.twoFactorRequired !== true)
    || !Array.isArray(value.providers) || !value.providers.every((provider) => Number.isInteger(provider))) return null;
  return { providers: value.providers, providersInfo: value.providersInfo ?? {} };
}

/** A rejected second factor must never blame the already-accepted master password. */
export function twoFactorErrorMessage(error: unknown, fallback: (error: unknown) => string): string {
  const kind = (error as { kind?: string } | null)?.kind;
  if (kind === 'auth' || kind === 'twoFactorRequired' || kind === 'twoFactorInvalid') return '验证码不正确或已过期，请重试';
  return fallback(error);
}
