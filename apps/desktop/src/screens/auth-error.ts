import type { TwoFactorChallenge } from '@1warden/vault';

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
