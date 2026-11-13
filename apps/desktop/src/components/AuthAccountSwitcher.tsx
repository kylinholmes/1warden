import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { host, IconPlus, Select, useAccounts, type SavedAccount } from '@1warden/ui';
import type { UserProfile } from '@1warden/vault';
import { accountKey } from '../application/account-target';
import { createProfileCache } from '../application/profile-cache';
import { ProfileAvatar } from './ProfileAvatar';

const ADD_ACCOUNT = 'add-account';
export function AuthAccountSwitcher({ account, profile, onChoose }: {
  account: SavedAccount; profile: UserProfile | null;
  onChoose: (account: SavedAccount | null) => Promise<void>;
}) {
  const saved = useAccounts();
  const store = useLocalStore(() => ({ profiles: {} as Record<string, UserProfile | null>, pending: false, error: null as string | null }));
  const [profiles, setProfiles] = useStoreField(store, 'profiles');
  const [pending, setPending] = useStoreField(store, 'pending');
  const [error, setError] = useStoreField(store, 'error');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentKey = accountKey(account);
  const entries = new Map<string, SavedAccount>();
  for (const entry of [account, ...(saved ?? [])]) {
    try { const key = accountKey(entry); if (!entries.has(key)) entries.set(key, entry); } catch { /* Invalid legacy entries cannot be selected. */ }
  }
  const identities = [...entries.keys()].join('\n');
  useEffect(() => {
    let alive = true;
    const cache = createProfileCache(host().storage);
    void Promise.all([...entries].map(async ([key, entry]) => [key, await cache.load(entry)] as const))
      .then(values => { if (alive) setProfiles(Object.fromEntries(values)); });
    return () => { alive = false; };
  }, [identities]);
  const shown = (key: string) => key === currentKey ? profile ?? profiles[key] ?? null : profiles[key] ?? null;
  function identity(entry: SavedAccount, key: string, full: boolean) {
    const presentation = shown(key);
    return <span className="auth-account-identity">
      <ProfileAvatar profile={presentation} fallback={entry.email} className="h-8 w-8 text-sm" />
      <span className="auth-account-copy"><span>{presentation?.displayName || entry.email}</span>
        {presentation?.displayName && <span>{entry.email}</span>}
        {full && <span className="auth-account-server">{serverLabel(entry.serverUrl)}</span>}
      </span>
    </span>;
  }
  const options = [...entries].map(([value, entry]) => ({ value, label: `${shown(value)?.displayName || entry.email} ${entry.email} ${entry.serverUrl}` }));
  options.push({ value: ADD_ACCOUNT, label: '添加账户' });
  return <div className="auth-account-switcher">
    <Select aria-label="切换账户" value={currentKey} options={options} disabled={pending}
      className="auth-account-trigger" popupClassName="auth-account-popup"
      renderValue={() => identity(account, currentKey, false)}
      renderOption={option => option.value === ADD_ACCOUNT ? <span className="auth-account-add"><IconPlus size={16} />添加账户</span>
        : identity(entries.get(option.value)!, option.value, true)}
      onChange={value => {
        setPending(true); setError(null);
        void onChoose(value === ADD_ACCOUNT ? null : entries.get(value)!).catch(() => {
          if (mounted.current) setError('无法切换账户，请重试');
        }).finally(() => { if (mounted.current) setPending(false); });
      }} />
    {error && <p role="alert" className="auth-account-error">{error}</p>}
  </div>;
}
function serverLabel(value: string) {
  try { const url = new URL(value); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return value; }
}
