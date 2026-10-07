import type { TwoFactorChallenge } from '@coffer/vault';

/** Shared by first connection and re-unlock, including errors received over RPC. */
export function twoFactorChallenge(error: unknown): TwoFactorChallenge | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as Partial<TwoFactorChallenge> & { kind?: string; twoFactorRequired?: boolean };
  if ((value.kind !== 'twoFactorRequired' && value.twoFactorRequired !== true)
    || !Array.isArray(value.providers) || !value.providers.every((provider) => Number.isInteger(provider))) return null;
  return { providers: value.providers, providersInfo: value.providersInfo ?? {} };
}
