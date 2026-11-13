import { useLocalStore, useStoreField } from '@1warden/state/react';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useEffect, useRef, type FormEvent } from 'react';
import type { ApplicationClient } from '../application/types';
import type { TwoFactorChallenge } from '@1warden/vault';
import { BackButton, IconAlert, IconGlobe, IconSpinner, PasswordInput, ServerSpeed, TwoFactorForm, type SavedAccount } from '@1warden/ui';
import { authenticationErrorMessage, twoFactorChallenge, twoFactorErrorMessage } from './auth-error';
import { AuthPage } from '../components/AuthPage';
import { AuthAccountSwitcher } from '../components/AuthAccountSwitcher';

interface Props {
  client: ApplicationClient;
  onUnlocked: () => void;
  onDisconnect: () => void;
  directEntry?: boolean | undefined;
  onSwitchAccount?: ((account: SavedAccount | null) => Promise<void>) | undefined;
}

/** Saved-account unlock shares the login page's layout and asks only for the secret. */
export function Unlock({ client, onUnlocked, onDisconnect, directEntry, onSwitchAccount }: Props) {
  const viewStore = useLocalStore(() => {
    const password = '';
    const busy = false;
    const error = (null) as string | null;
    const challenge = (null) as TwoFactorChallenge | null;
    return { password, busy, error, challenge };
  });
  const [password, setPassword] = useStoreField(viewStore, 'password');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [challenge, setChallenge] = useStoreField(viewStore, 'challenge');
  const { account, profile } = client.getSnapshot();
  const inputRef = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  useEffect(() => () => { operation.current++; }, []);

  // 解锁屏一出现就聚焦输入框 —— 用户按下快捷键后应该能直接开始打字
  useEffect(() => { if (!busy && !challenge) inputRef.current?.focus(); }, [busy, challenge]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (viewStore.getState().busy || !password) return;
    const version = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      await client.unlock(password);
      if (version !== operation.current) return;
      setPassword(''); // 成功后立刻从组件状态里清掉
      onUnlocked();
    } catch (err) {
      if (version !== operation.current) return;
      const nextChallenge = twoFactorChallenge(err);
      if (nextChallenge) setChallenge(nextChallenge);
      else setError(authenticationErrorMessage(err));
      setPassword('');
      // Focus is restored after React has re-enabled the input.
    } finally {
      if (version === operation.current) setBusy(false);
    }
  }

  async function submitCode(code: string, provider: number, remember: boolean): Promise<void> {
    const version = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      await client.connectWithTwoFactor(code, provider, remember);
      if (version !== operation.current) return;
      onUnlocked();
    } catch (err) {
      if (version !== operation.current) return;
      if ((err as { kind?: string } | null)?.kind === 'authRestartRequired') setChallenge(null);
      setError(twoFactorErrorMessage(err, authenticationErrorMessage));
    } finally { if (version === operation.current) setBusy(false); }
  }

  return (
    /* 整块背景可拖 —— 和连接屏同理，这一屏没有顶部带子（见 Connect.tsx） */
    <AuthPage>
      <section className="auth-connect auth-unlock">
        {!directEntry && <BackButton label="返回首页" showLabel className="auth-back" onBack={() => { operation.current++; setPassword(''); onDisconnect(); }} />}
        <h1 className="auth-title">{challenge ? '两步验证，解锁保险库' : '解锁保险库'}</h1>
        <div className="auth-unlock-grid">
        <div className="auth-unlock-account">
        {directEntry && account && onSwitchAccount ? <AuthAccountSwitcher account={account} profile={profile}
          onChoose={async target => { operation.current++; setPassword(''); setError(null); setChallenge(null); await onSwitchAccount(target); }} /> : <div className="auth-unlock-identity">
          <ProfileAvatar profile={profile} fallback={account?.email ?? ''} className="h-9 w-9 text-md" />
          <div className="min-w-0 flex-1"><p className="truncate text-md font-medium">{profile?.displayName || account?.email}</p>
          {profile?.displayName && <p className="mt-1 truncate text-xs text-[var(--ink-secondary)]">{account?.email}</p>}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--ink-tertiary)]">
            <IconGlobe size={12} className="shrink-0" />
            <span className="truncate">{hostOf(account?.serverUrl ?? '')}</span>
          </p></div>
        </div>}

        {!challenge && account && <ServerSpeed collapsible serverUrl={account.serverUrl} disabled={busy} />}
        </div>
        <div className="auth-unlock-action">
        {challenge ? <div><TwoFactorForm providers={challenge.providers} busy={busy}
          onSubmit={({ code, provider, remember }) => { void submitCode(code, provider, remember); }} /></div>
          : <form onSubmit={submit} className="auth-unlock-form">
          <div><label className="auth-field-label" htmlFor="unlock-password">主密码</label>
          <PasswordInput
            ref={inputRef}
            id="unlock-password"
            required value={password} disabled={busy} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入主密码"
            aria-label="主密码"
            aria-invalid={!!error} aria-describedby={error ? 'unlock-error' : undefined}
          /></div>
          <button
            type="submit" disabled={busy || password.length === 0}
            className="btn btn-primary auth-submit w-full"
          >
            {busy && <IconSpinner size={15} />}
            {busy ? '解锁中…' : '解锁'}
          </button>
        </form>}

        {error && (
          <p id="unlock-error" role="alert" className="mt-4 flex items-start gap-2 text-sm text-[var(--risk)]">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
        </div>
        </div>
      </section>
    </AuthPage>
  );
}

/** 只用于展示的主机名 —— 真正的解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
