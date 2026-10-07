import type { VaultClient } from '@coffer/vault';
import { APPLICATION_METHODS } from './client';
import { accountKey, lockedAccount } from './account-target';
import { createVaultService } from './service';
import type { ProfileCache } from './profile-cache';
import type { ApplicationService } from './types';

interface AccountSession {
  vault: VaultClient;
  service: ApplicationService;
}

/** Native sessions stay in memory. Each VaultClient owns its keys, transport and lock timer. */
export function createAccountSessions(createVault: () => VaultClient, profileCache?: ProfileCache) {
  const sessions = new Map<string, AccountSession>();
  const listeners = new Set<() => void>();
  const createSession = (): AccountSession => {
    const vault = createVault();
    return { vault, service: createVaultService(vault, profileCache) };
  };
  let active = createSession();
  let selection = 0;
  let pending: { session: AccountSession; key: string; selection: number } | null = null;

  function cancelAuthentication() {
    const previous = pending;
    pending = null;
    previous?.session.vault.logout();
  }

  function publishSelected(session: AccountSession) {
    active = session;
    for (const listener of listeners) listener();
  }

  function adopt(candidate: NonNullable<typeof pending>) {
    if (pending !== candidate || candidate.selection !== selection) {
      candidate.session.vault.logout();
      throw new Error('登录请求已过期，请重新选择账户');
    }
    const previous = sessions.get(candidate.key);
    pending = null;
    sessions.set(candidate.key, candidate.session);
    if (previous && previous !== candidate.session) previous.vault.logout();
    publishSelected(candidate.session);
  }

  // Capture the service before any await: a later switch must never redirect an operation.
  const service = Object.fromEntries(APPLICATION_METHODS.map((method) => [method, (...args: unknown[]) => {
    const selected = active.service;
    const operation = selected[method] as (...values: unknown[]) => Promise<unknown>;
    return operation(...args);
  }])) as unknown as ApplicationService;

  service.snapshot = async () => {
    const selected = active;
    const snapshot = await selected.service.snapshot();
    if (selected !== active) return service.snapshot();
    return { ...snapshot, unlockedAccounts: [...sessions].filter(([, session]) => session.vault.isUnlocked())
      .map(([key]) => key) };
  };

  service.switchAccount = async (target) => {
    const account = target ? lockedAccount(target) : null;
    const key = account ? accountKey(account) : null;
    cancelAuthentication();
    selection++;
    // Cancel an unfinished password/OTP challenge, while unlocked sessions keep their own timer.
    if (!active.vault.isUnlocked()) active.vault.lock();
    let selected = key ? sessions.get(key) : undefined;
    if (!selected || selected.vault.getSession().status === 'loggedOut') {
      selected = createSession();
      if (account && key) {
        selected.vault.getSession().setAccount(account);
        sessions.set(key, selected);
      }
    }
    publishSelected(selected);
  };

  service.connect = async (params) => {
    const account = lockedAccount(params);
    cancelAuthentication();
    const candidate = { session: createSession(), key: accountKey(account), selection };
    pending = candidate;
    try {
      await candidate.session.service.connect({ serverUrl: account.serverUrl, email: account.email,
        masterPassword: params.masterPassword });
      adopt(candidate);
    } catch (error) {
      if (pending !== candidate || (error as { kind?: string } | null)?.kind !== 'twoFactorRequired') {
        if (pending === candidate) pending = null;
        candidate.session.vault.logout();
      }
      throw error;
    }
  };

  service.connectWithTwoFactor = async (code, provider, remember) => {
    const candidate = pending;
    if (!candidate) {
      const selected = active.service;
      return selected.connectWithTwoFactor(code, provider, remember);
    }
    await candidate.session.service.connectWithTwoFactor(code, provider, remember);
    adopt(candidate);
  };

  service.lock = async () => {
    const selected = active.service;
    cancelAuthentication(); selection++;
    await selected.lock();
  };

  service.logout = async () => {
    const selected = active.service;
    cancelAuthentication(); selection++;
    await selected.logout();
  };

  return {
    service,
    getActiveVault: () => active.vault,
    subscribeActiveVault(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
