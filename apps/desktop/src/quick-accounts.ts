import { host, readAccounts } from '@1warden/ui';
import { accountKey, lockedAccount, type AccountTarget } from './application/account-target';
import { createProfileCache } from './application/profile-cache';
import type { ApplicationSnapshot } from './application/types';
import type { QuickAccount } from './quick-bridge';

/** Select only remembered identities and already-authorized presentation cache. */
export async function loadQuickAccounts(snapshot: ApplicationSnapshot, selected: AccountTarget | null = snapshot.account): Promise<QuickAccount[]> {
  const remembered = await readAccounts();
  const identities = new Map<string, AccountTarget>();
  for (const value of [...remembered, ...(selected ? [selected] : [])]) {
    try {
      const account = lockedAccount(value); const key = accountKey(account);
      if (!identities.has(key)) identities.set(key, { serverUrl: account.serverUrl, email: account.email });
    } catch { /* Ignore invalid legacy storage entries. */ }
  }
  const cache = createProfileCache(host().storage);
  return Promise.all([...identities].map(async ([id, account]) => {
    const current = snapshot.account && accountKey(snapshot.account) === id
      && (snapshot.profile !== null || snapshot.profileReady);
    const profile = current ? snapshot.profile : await cache.load(account);
    return { id, ...account, displayName: profile?.displayName ?? '', avatarDataUrl: profile?.avatarDataUrl ?? null };
  }));
}

export type QuickAccountNavigation = (target: AccountTarget | null) => Promise<void>;
export type SubscribeQuickAccountNavigation = (handler: QuickAccountNavigation) => () => void;

/** Local main-window routing only; no secrets or authentication cross this boundary. */
export function createQuickAccountNavigation() {
  let current: QuickAccountNavigation | null = null;
  return {
    subscribe: ((handler) => {
      current = handler;
      return () => { if (current === handler) current = null; };
    }) satisfies SubscribeQuickAccountNavigation,
    async open(target: AccountTarget | null) {
      if (!current) throw new Error('主窗口正在载入，请稍后重试');
      await current(target);
    },
  };
}
