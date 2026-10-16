import type { VaultClient, SessionStatus } from '@1warden/vault';
import { APPLICATION_METHODS } from './client';
import { accountKey, lockedAccount } from './account-target';
import { createVaultService } from './service';
import { createAccountMigration } from './account-migration';
import type { AccountTarget } from './account-target';
import type { ProfileCache } from './profile-cache';
import type { ApplicationService } from './types';

interface AccountSession {
  vault: VaultClient;
  service: ApplicationService;
}

/** Native sessions stay in memory. Each VaultClient owns its keys, transport and lock timer. */
export function createAccountSessions(createVault: (onStatus: (status: SessionStatus) => void) => VaultClient, profileCache?: ProfileCache,
  onAuthenticated?: (account: AccountTarget) => void) {
  const sessions = new Map<string, AccountSession>();
  const listeners = new Set<() => void>();
  const createSession = (): AccountSession => {
    const vault = createVault(status => {
      const candidate = pending;
      // The normal login route is an empty connection session. Publish its
      // authenticated vault before sync; replacing an existing account directly
      // keeps the original atomic operation/account-boundary semantics.
      if (status === 'unlocked' && candidate?.session.vault === vault && candidate.selection === selection
        && active.vault.getSession().account === null) adopt(candidate);
    });
    return { vault, service: createVaultService(vault, profileCache, () => selectionGuard(vault)) };
  };
  let active = createSession();
  let selection = 0;
  let pending: { session: AccountSession; key: string; selection: number; adopted: boolean } | null = null;

  function selectionGuard(vault: VaultClient): () => void {
    const selectedAt = selection;
    return () => {
      if (active.vault !== vault || selectedAt !== selection) throw new Error('操作已取消，账户已切换或变更');
    };
  }

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
    if (candidate.adopted) return;
    if (pending !== candidate || candidate.selection !== selection) {
      candidate.session.vault.logout();
      throw new Error('登录请求已过期，请重新选择账户');
    }
    const previous = sessions.get(candidate.key);
    candidate.adopted = true;
    pending = null;
    sessions.set(candidate.key, candidate.session);
    if (previous && previous !== candidate.session) previous.vault.logout();
    const account = candidate.session.vault.getSession().account;
    if (account) onAuthenticated?.({ serverUrl: account.serverUrl, email: account.email });
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

  function migration(source: AccountTarget) {
    const sourceIdentity = accountKey(source);
    const selected = active;
    const selectedAt = selection;
    const account = selected.vault.getSession().account;
    if (account && accountKey(account) === sourceIdentity) throw new Error('不能将当前账户导入到相同账户');
    const origin = sessions.get(sourceIdentity);
    if (!origin || !origin.vault.isUnlocked()) throw new Error('请先解锁来源账户');
    return createAccountMigration(origin.vault, selected.vault, () => {
      if (selected !== active || selectedAt !== selection || sessions.get(sourceIdentity) !== origin) {
        throw new Error('迁移已取消，账户已切换或变更');
      }
    });
  }
  service.previewAccountImport = async source => migration(source).preview();
  service.importAccount = async (source, options) => migration(source).import(options);
  service.previewBulkDelete = async scope => {
    const vault = active.vault;
    return vault.previewBulkDelete(scope, selectionGuard(vault));
  };
  service.commitBulkDelete = async token => {
    const vault = active.vault;
    return vault.commitBulkDelete(token, selectionGuard(vault));
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
    const candidate = { session: createSession(), key: accountKey(account), selection, adopted: false };
    pending = candidate;
    try {
      await candidate.session.service.connect({ serverUrl: account.serverUrl, email: account.email,
        masterPassword: params.masterPassword });
      adopt(candidate);
    } catch (error) {
      if (!candidate.adopted && (pending !== candidate || (error as { kind?: string } | null)?.kind !== 'twoFactorRequired')) {
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
