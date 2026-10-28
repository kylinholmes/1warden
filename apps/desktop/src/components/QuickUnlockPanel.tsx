import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconSpinner, TwoFactorForm } from '@1warden/ui';
import type { QuickAccount } from '../quick-bridge';
import type { QuickAuthRequest, QuickAuthResult } from '../quick-auth';
import { ProfileAvatar } from './ProfileAvatar';
import { QuickLockedAccounts } from './QuickLockedAccounts';

export type QuickAuthentication = (accountId: string, input: Pick<QuickAuthRequest, 'action' | 'password' | 'code' | 'provider' | 'remember'>) => Promise<QuickAuthResult>;

/** A complete, cancellable authentication journey in the window that requested it. */
export function QuickUnlockPanel({ accounts, loading, autoSelect = true, reset = 0, externalError = null, backRef, onAuthenticate, onCancel, onUnlocked, onLogin, onClose }: {
  accounts: readonly QuickAccount[]; loading: boolean; autoSelect?: boolean;
  reset?: number;
  externalError?: string | null;
  backRef?: Ref<() => void>;
  onAuthenticate: QuickAuthentication; onCancel: () => void; onUnlocked: () => void;
  onLogin: () => void; onClose: () => void;
}) {
  const store = useLocalStore(() => ({ account: null as QuickAccount | null, stage: 'password' as 'password' | 'twoFactor',
    password: '', providers: [] as number[], busy: false, error: null as string | null }));
  const [account, setAccount] = useStoreField(store, 'account');
  const [stage, setStage] = useStoreField(store, 'stage');
  const [password, setPassword] = useStoreField(store, 'password');
  const [providers, setProviders] = useStoreField(store, 'providers');
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const message = error ?? externalError;
  const passwordInput = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const pending = useRef(false);
  const autoSelected = useRef(false);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => () => { operation.current++; pending.current = false; setBusy(false); cancel.current(); }, []);
  const previousReset = useRef(reset);
  useEffect(() => {
    if (reset === previousReset.current) return;
    previousReset.current = reset; operation.current++; pending.current = false;
    setPassword(''); setStage('password'); setProviders([]); setBusy(false); setError(null);
  }, [reset]);
  useEffect(() => {
    if (account && stage === 'password' && !busy) passwordInput.current?.focus();
  }, [account?.id, stage, busy]);
  useEffect(() => {
    if (autoSelect && !loading && accounts.length === 1 && !autoSelected.current) {
      autoSelected.current = true; void select(accounts[0]!);
    }
  }, [autoSelect, loading, accounts]);

  async function authenticate(selected: QuickAccount, input: Parameters<QuickAuthentication>[1]) {
    if (pending.current) return;
    pending.current = true;
    const version = ++operation.current;
    setBusy(true); setError(null);
    try {
      const result = await onAuthenticate(selected.id, input);
      if (version !== operation.current) return;
      if (result.stage === 'unlocked' && !result.error) { onUnlocked(); return; }
      setStage(result.stage === 'twoFactor' ? 'twoFactor' : 'password');
      setProviders(result.providers ?? []); setError(result.error ?? null);
    } catch (err) {
      if (version === operation.current) setError(err instanceof Error ? err.message : '暂时无法解锁，请重试');
    } finally {
      if (version === operation.current) { pending.current = false; setBusy(false); }
    }
  }
  async function select(selected: QuickAccount) {
    setAccount(selected); setStage('password'); setPassword('');
    await authenticate(selected, { action: 'select' });
  }
  function back() {
    operation.current++; pending.current = false; autoSelected.current = true;
    onCancel(); setBusy(false); setPassword(''); setError(null);
    if (stage === 'twoFactor') { setStage('password'); setProviders([]); }
    else if (accounts.length > 1 || !autoSelect) setAccount(null);
    else onClose();
  }
  function escape() { if (account) back(); else { onCancel(); onClose(); } }
  useImperativeHandle(backRef, () => escape);
  // A pinned window can lose focus without unmounting. Never retain a typed secret there.
  useEffect(() => {
    const clear = () => { setPassword(''); };
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);

  return <section className="flex min-h-0 flex-1 flex-col" aria-label="解锁保险库" onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    escape();
  }}>
    {!account ? <QuickLockedAccounts accounts={accounts} busy={loading || busy} onOpenAccount={id => {
      if (id === null) onLogin();
      else { const selected = accounts.find(value => value.id === id); if (selected) void select(selected); }
    }} /> : <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-3">
      <h1 className="sr-only">解锁保险库</h1>
      <button type="button" className="btn btn-ghost absolute left-3 top-3 h-8 px-2 text-xs" onClick={back}
        aria-label={stage === 'twoFactor' ? '返回密码解锁' : accounts.length > 1 || !autoSelect ? '返回选择账户' : '关闭快速搜索'}>← 返回</button>
      <div className="my-auto mx-auto w-full max-w-[320px] shrink-0 text-center">
        {stage === 'password' && <ProfileAvatar profile={account} fallback={account.email} className={`mx-auto mb-2 h-16 w-16 text-2xl ${busy ? 'breathe' : ''}`} />}
        <p className="truncate px-5 text-sm font-medium" title={account.email}>{account.email || account.displayName}</p>
        <p className="mt-0.5 truncate text-xs text-[var(--ink-tertiary)]" title={account.serverUrl}>{serverLabel(account.serverUrl)}</p>
        {stage === 'twoFactor' ? <div className="mt-3 text-left"><TwoFactorForm providers={providers} busy={busy}
          onSubmit={fields => { void authenticate(account, { action: 'twoFactor', ...fields }); }} /></div>
          : <form className="mt-4 space-y-2" onSubmit={event => {
            event.preventDefault(); if (pending.current || !password) return;
            const submitted = password; setPassword('');
            void authenticate(account, { action: 'password', password: submitted });
          }}>
            <input ref={passwordInput} type="password" aria-label="主密码" placeholder="主密码" autoComplete="current-password"
              value={password} disabled={busy} required className="field secret py-2 text-center"
              aria-invalid={Boolean(message)} aria-describedby={message ? 'quick-unlock-error' : undefined}
              onChange={event => setPassword(event.target.value)} />
            <button type="submit" disabled={busy || !password} className="btn btn-primary w-full py-2">
              {busy && <IconSpinner size={15} />}{busy ? '正在解锁…' : '解锁并搜索'}
            </button>
          </form>}
        {message && <p id="quick-unlock-error" role="alert" className="mt-2 text-sm text-[var(--risk)]">{message}</p>}
      </div>
    </div>}
  </section>;
}
function serverLabel(value: string) {
  try { const url = new URL(value); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return value; }
}
