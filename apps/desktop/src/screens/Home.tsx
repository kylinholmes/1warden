import { useEffect } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { AccountIdentity, AccountPicker, host, IconSpinner, knownServers, useServerLatencies, useAccounts, type SavedAccount } from '@1warden/ui';
import type { UserProfile } from '@1warden/vault';
import type { ApplicationSnapshot } from '../application/types';
import { accountKey } from '../application/account-target';
import { createProfileCache } from '../application/profile-cache';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { AuthPage } from '../components/AuthPage';

/** Each row loads only its own existing presentation cache, never vault contents.
 * A fresh session profile takes precedence, including a deliberately removed avatar. */
function HomeAccountIdentity({ account, profile }: { account: SavedAccount; profile: UserProfile | null | undefined }) {
  const { serverUrl, email } = account;
  const key = JSON.stringify([serverUrl, email]);
  const store = useLocalStore(() => ({ cached: null as { key: string; value: UserProfile | null } | null }));
  const [cached, setCached] = useStoreField(store, 'cached');
  useEffect(() => {
    let alive = true;
    void createProfileCache(host().storage).load({ serverUrl, email }).then(value => {
      if (alive) setCached({ key, value });
    });
    return () => { alive = false; };
  }, [serverUrl, email, key, setCached]);
  const shown = profile !== undefined ? profile : cached?.key === key ? cached.value : null;
  return <AccountIdentity account={account} displayName={shown?.displayName}
    avatar={<ProfileAvatar profile={shown} fallback={email} className="h-9 w-9 text-md" />} />;
}

export function Home({ session, busy, onPick, onOther, onRegister, title = '登录你的保险库' }: { session: ApplicationSnapshot; busy: boolean; onPick: (account: SavedAccount) => void; onOther: () => void; onRegister: () => void; title?: string | undefined }) {
  const saved = useAccounts();
  const accounts = [...(saved ?? [])];
  if (session.account && !accounts.some(a => accountKey(a) === accountKey(session.account!))) accounts.unshift(session.account);
  useServerLatencies(knownServers(accounts).map(server => server.url));
  return <AuthPage label="账户首页">
    <section className="auth-home">
      <h1 className="auth-title">{title}</h1>
      <div className="auth-home-content">
      {saved === null ? <p className="flex items-center gap-2 text-sm text-[var(--ink-tertiary)]"><IconSpinner size={16} />正在读取账户…</p> : <>
        {accounts.length > 0 ? <AccountPicker accounts={accounts} busy={busy} onPick={onPick} onOther={onOther}
        renderIdentity={account => <HomeAccountIdentity account={account}
          profile={session.account && accountKey(session.account) === accountKey(account)
            && (session.profile !== null || session.profileReady) ? session.profile : undefined} />} /> :
          <button type="button" data-add-server disabled={busy} onClick={onOther} className="btn btn-primary auth-submit w-full">登录</button>}
        <button type="button" disabled={busy} onClick={onRegister} className="btn btn-ghost auth-home-register">注册</button>
      </>}
      </div>
    </section>
  </AuthPage>;
}
