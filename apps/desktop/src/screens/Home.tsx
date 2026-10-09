import { useEffect } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { AccountIdentity, AccountPicker, BrandMark, host, IconSpinner, useAccounts, type SavedAccount } from '@1warden/ui';
import type { UserProfile } from '@1warden/vault';
import type { ApplicationSnapshot } from '../application/types';
import { accountKey } from '../application/account-target';
import { createProfileCache } from '../application/profile-cache';
import { ProfileAvatar } from '../components/ProfileAvatar';

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

export function Home({ session, busy, onPick, onOther }: { session: ApplicationSnapshot; busy: boolean; onPick: (account: SavedAccount) => void; onOther: () => void }) {
  const saved = useAccounts();
  const accounts = [...(saved ?? [])];
  if (session.account && !accounts.some(a => accountKey(a) === accountKey(session.account!))) accounts.unshift(session.account);
  return <main aria-label="账户首页" className="below-titlebar flex h-full flex-col items-center overflow-y-auto bg-[var(--surface-canvas)] p-8" data-tauri-drag-region="deep">
    <div className="screen-in my-auto w-full max-w-[380px] shrink-0">
      <div className="mb-7 flex items-center gap-2.5"><BrandMark /><span className="text-xl font-semibold">1Warden</span></div>
      <h1 className="mb-5 text-md font-medium text-[var(--ink-secondary)]">{saved === null ? '正在读取账户' : accounts.length ? '选择要连接的账户' : '添加服务器，开始使用'}</h1>
      {saved === null ? <p className="flex items-center gap-2 text-sm text-[var(--ink-tertiary)]"><IconSpinner size={16} />正在读取账户…</p> : <AccountPicker accounts={accounts} busy={busy} onPick={onPick} onOther={onOther}
        renderIdentity={account => <HomeAccountIdentity account={account}
          profile={session.account && accountKey(session.account) === accountKey(account)
            && (session.profile !== null || session.profileReady) ? session.profile : undefined} />} />}
      <p className="mt-8 text-xs leading-relaxed text-[var(--ink-tertiary)]">主密码只在本地用于派生密钥，永不发送到服务器。服务器地址和邮箱会留在本机，方便下次连接。</p>
      {!!session.unlockedAccounts?.length && <p className="mt-3 text-xs text-[var(--ink-tertiary)]">已解锁的账户可以直接进入；返回首页不会退出账户，自动锁定仍按原期限生效。</p>}
    </div>
  </main>;
}
