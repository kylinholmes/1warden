import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconArrowLeft, IconSpinner, PasswordInput, TwoFactorForm } from '@1warden/ui';
import type { QuickAccount } from '../quick-bridge';
import type { QuickAuthRequest, QuickAuthResult } from '../quick-auth';
import { QuickLockedAccounts } from './QuickLockedAccounts';

export type QuickAuthentication = (accountId: string, input: Pick<QuickAuthRequest, 'action' | 'password' | 'code' | 'provider' | 'remember'>) => Promise<QuickAuthResult>;

/** A complete, cancellable authentication journey in the window that requested it. */
export function QuickUnlockPanel({ accounts, loading, autoSelect = true, initialAccountId, reset = 0, externalError = null, backRef, cancelRef, onAuthenticate, onCancel, onUnlocked, onLogin, onClose }: {
  accounts: readonly QuickAccount[]; loading: boolean; autoSelect?: boolean;
  reset?: number;
  initialAccountId?: string | undefined;
  externalError?: string | null;
  backRef?: Ref<() => void>;
  cancelRef?: Ref<() => void>;
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
  const errorMessage = useRef<HTMLParagraphElement>(null);
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
    if (autoSelect && !loading && accounts.length && !autoSelected.current) {
      autoSelected.current = true; void select(accounts.find(value => value.id === initialAccountId) ?? accounts[0]!);
    }
  }, [autoSelect, loading, accounts, initialAccountId]);
  useEffect(() => { if (message) errorMessage.current?.scrollIntoView?.({ block: 'nearest' }); }, [message]);

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
    if (account?.id === selected.id) { passwordInput.current?.focus(); return; }
    if (account || pending.current) { operation.current++; pending.current = false; onCancel(); }
    setAccount(selected); setStage('password'); setPassword(''); setProviders([]); setError(null); setBusy(false);
    await authenticate(selected, { action: 'select' });
  }
  function back() {
    operation.current++; pending.current = false; autoSelected.current = true;
    onCancel(); setBusy(false); setPassword(''); setError(null);
    if (stage === 'twoFactor') { setStage('password'); setProviders([]); }
    else if (accounts.length > 1 || !autoSelect) setAccount(null);
    else onClose();
  }
  function cancelCurrent() {
    operation.current++; pending.current = false; onCancel();
    setBusy(false); setPassword(''); setError(null); setProviders([]); setStage('password');
  }
  function escape() { cancelCurrent(); onClose(); }
  useImperativeHandle(backRef, () => escape);
  useImperativeHandle(cancelRef, () => cancelCurrent);
  // A pinned window can lose focus without unmounting. Never retain a typed secret there.
  useEffect(() => {
    const clear = () => { setPassword(''); };
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);

  function openAccount(id: string | null) {
    if (id === null) {
      operation.current++; pending.current = false; onCancel(); setBusy(false); setPassword(''); onLogin();
    } else { const selected = accounts.find(value => value.id === id); if (selected) void select(selected); }
  }
  const multiple = accounts.length > 1;
  return <section className="quick-unlock-layout" data-single={!multiple ? '' : undefined} aria-label="解锁保险库" onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    escape();
  }}>
    {multiple && <aside className="quick-unlock-sidebar"><h2>账户</h2><QuickLockedAccounts sidebar accounts={accounts} busy={loading}
      activeId={account?.id} onOpenAccount={openAccount} /></aside>}
    {!account ? multiple ? <div className="quick-unlock-main"><div className="quick-unlock-heading"><h1>选择账户</h1></div></div>
      : <QuickLockedAccounts accounts={accounts} busy={loading || busy} onOpenAccount={openAccount} />
      : <div className="quick-unlock-main" data-stage={stage}>
      <div className="quick-unlock-form">
        <div className="quick-unlock-heading"><h1>{stage === 'twoFactor' ? '两步验证' : '解锁保险库'}</h1>
          {stage === 'twoFactor' && <button type="button" className="btn btn-ghost quick-unlock-back" onClick={back}
            aria-label="返回密码解锁"><IconArrowLeft size={17} /></button>}
        </div>
        <div className="quick-unlock-identity">
          <p title={account.email}>{account.email || account.displayName}</p>
          <p title={account.serverUrl}>{serverLabel(account.serverUrl)}</p>
        </div>
        {stage === 'twoFactor' ? <div className="quick-unlock-two-factor"><TwoFactorForm providers={providers} busy={busy}
          onSubmit={fields => { void authenticate(account, { action: 'twoFactor', ...fields }); }} /></div>
          : <form className="quick-unlock-password" onSubmit={event => {
            event.preventDefault(); if (pending.current || !password) return;
            const submitted = password; setPassword('');
            void authenticate(account, { action: 'password', password: submitted });
          }}>
            <div><label className="quick-unlock-label" htmlFor="quick-unlock-password">主密码</label>
            <PasswordInput ref={passwordInput} id="quick-unlock-password" aria-label="主密码" placeholder="输入主密码" autoComplete="current-password"
              value={password} disabled={busy} required
              aria-invalid={Boolean(message)} aria-describedby={message ? 'quick-unlock-error' : undefined}
              onChange={event => setPassword(event.target.value)} /></div>
            <button type="submit" disabled={busy || !password} className="btn btn-primary w-full py-2">
              {busy && <IconSpinner size={15} />}{busy ? '正在解锁…' : '解锁'}
            </button>
          </form>}
        {message && <p ref={errorMessage} id="quick-unlock-error" role="alert" className="quick-unlock-error">{message}</p>}
      </div>
    </div>}
  </section>;
}
function serverLabel(value: string) {
  try { const url = new URL(value); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return value; }
}
