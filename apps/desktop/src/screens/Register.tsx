import { useEffect, useRef, type FormEvent } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { beginRegistration, finishRegistration, HttpClient, registrationServerUrl, serverEnvironment, type RegistrationStep } from '@1warden/api';
import { apiMessageOf, BackButton, BrandMark, Field, host, IconSpinner, initialServerUrl, ServerSelector, useAccounts, type SavedAccount } from '@1warden/ui';
import type { ApplicationClient, ConnectionDraft } from '../application/types';
import { openWebsite } from '../open-website';
import type { CertInfo } from '../trust';
import { CertificatePrompt } from './Connect';
import { createRegistrationKeys, validateRegistrationPassword } from './registration-keys';

type Step = { kind: 'identity' } | RegistrationStep | { kind: 'complete' };
type PublicFields = Pick<ConnectionDraft, 'serverUrl' | 'email'>;

interface RegisterProps {
  client: ApplicationClient;
  initialDraft: ConnectionDraft | undefined;
  onHome: () => Promise<void>;
  onLogin: (fields: PublicFields) => Promise<void>;
}

export function Register(props: RegisterProps) {
  const accounts = useAccounts();
  if (accounts === null) return <main className="below-titlebar flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-secondary)]"><IconSpinner size={16} />正在读取服务器…</main>;
  return <RegistrationForm {...props} accounts={accounts} />;
}

/** Registration never creates a logged-in session or saves unencrypted credentials. */
function RegistrationForm({ client, initialDraft, onHome, onLogin, accounts }: RegisterProps & { accounts: SavedAccount[] }) {
  const store = useLocalStore(() => ({ serverUrl: initialServerUrl(initialDraft?.serverUrl, accounts), email: initialDraft?.email ?? '', name: '',
    password: '', confirmation: '', step: { kind: 'identity' } as Step,
    busy: false, error: null as string | null, cert: null as CertInfo | null }));
  const [serverUrl, setServerUrl] = useStoreField(store, 'serverUrl');
  const [email, setEmail] = useStoreField(store, 'email');
  const [name, setName] = useStoreField(store, 'name');
  const [password, setPassword] = useStoreField(store, 'password');
  const [confirmation, setConfirmation] = useStoreField(store, 'confirmation');
  const [step, setStep] = useStoreField(store, 'step');
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const [cert, setCert] = useStoreField(store, 'cert');
  const cloudRegion = serverEnvironment(serverUrl).cloudRegion;
  const mounted = useRef(true);
  const leaving = useRef(false);
  const submitting = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const draft: ConnectionDraft = { serverUrl, email, error: null, intent: 'register',
      ...(initialDraft?.returnAccount ? { returnAccount: initialDraft.returnAccount } : {}) };
    writes.current = writes.current.then(() => {
      if (mounted.current && !leaving.current) return client.connectionDraft?.save(draft);
    }).catch(() => {});
  }, [client, serverUrl, email, initialDraft]);

  function message(cause: unknown): string {
    const kind = (cause as { kind?: string })?.kind;
    // Login's auth translation would incorrectly call registration rejection a bad password.
    return ['auth', 'notFound', 'malformedResponse'].includes(kind ?? '') && cause instanceof Error ? cause.message : apiMessageOf(cause);
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (submitting.current || leaving.current) return;
    if (cloudRegion) { await openWebVault(); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const baseUrl = registrationServerUrl(serverUrl);
      const normalizedEmail = email.trim().toLowerCase();
      const http = new HttpClient({ baseUrl, fetchImpl: host().fetch });
      if (step.kind === 'identity' || step.kind === 'verifyEmail') {
        const next = await beginRegistration(http, { email: normalizedEmail, name });
        if (!mounted.current) return;
        setServerUrl(baseUrl); setEmail(normalizedEmail); setStep(next);
      } else if (step.kind === 'setPassword') {
        validateRegistrationPassword(password, confirmation);
        const keys = await createRegistrationKeys(normalizedEmail, password);
        if (!mounted.current) return;
        await finishRegistration(http, { ...keys, email: normalizedEmail, emailVerificationToken: step.token, masterPasswordHint: null });
        if (!mounted.current) return;
        setPassword(''); setConfirmation(''); setStep({ kind: 'complete' });
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (client.capabilities.native && (cause as { kind?: string })?.kind === 'certUntrusted') {
        try {
          const { probeCertificate } = await import('../trust');
          const certificate = await probeCertificate(serverUrl);
          if (mounted.current) setCert(certificate);
        } catch (probeError) { if (mounted.current) setError(message(probeError)); }
      } else setError(message(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function leave(destination: 'home' | 'login') {
    if (submitting.current || leaving.current) return;
    leaving.current = true; setBusy(true); setPassword(''); setConfirmation('');
    try {
      await writes.current;
      if (destination === 'home') await onHome();
      else await onLogin({ serverUrl, email });
    } catch (cause) {
      leaving.current = false;
      if (mounted.current) { setError(message(cause)); setBusy(false); }
    }
  }
  async function openWebVault() {
    try { await openWebsite(`${registrationServerUrl(serverUrl)}/#/register`); }
    catch (cause) { setError(message(cause)); }
  }
  async function trustAndRetry() {
    if (!cert || busy) return;
    setBusy(true);
    try {
      const { trustCertificate } = await import('../trust');
      await trustCertificate(serverUrl, cert.fingerprint);
      if (!mounted.current) return;
      setCert(null); await submit();
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <main aria-label="注册账户" className="below-titlebar flex h-full flex-col items-center overflow-y-auto bg-[var(--surface-canvas)] p-8" data-tauri-drag-region="deep">
    <div className="screen-in my-auto w-full max-w-[380px] shrink-0">
      <div className="mb-7 flex items-center gap-2.5"><BrandMark /><span className="text-xl font-semibold">1Warden</span></div>
      <BackButton label="返回首页" showLabel className="mb-4" onBack={() => { void leave('home'); }} />
      <h1 className="text-xl font-semibold">{step.kind === 'complete' ? '账户已创建' : step.kind === 'verifyEmail' ? '检查你的邮箱' : step.kind === 'setPassword' ? '设置主密码' : '创建账户'}</h1>
      {cert ? <div className="mt-5"><CertificatePrompt cert={cert} host={new URL(serverUrl).host} busy={busy}
        onCancel={() => setCert(null)} onTrust={() => { void trustAndRetry(); }} /></div> : <>
        {step.kind === 'identity' && <>
          <p className="mb-5 mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">在你选择的服务器上注册。已有账户可直接登录。</p>
          <form onSubmit={event => { void submit(event); }} className="space-y-4">
            <ServerSelector value={serverUrl} accounts={accounts} disabled={busy} onChange={url => { setServerUrl(url); setError(null); }} />
            <Field label={cloudRegion ? '邮箱（可选）' : '邮箱'}><input type="email" autoComplete="email" required={!cloudRegion} autoFocus disabled={busy} value={email} onChange={event => setEmail(event.target.value)} className="field" /></Field>
            {cloudRegion ? <>
              <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">在 Bitwarden {cloudRegion === 'EU' ? '欧洲' : '美国'}区官网完成邮箱验证和账户注册，然后返回这里登录。</p>
              <button type="button" disabled={busy} className="btn btn-primary w-full py-2.5" onClick={() => { void openWebVault(); }}>前往 Bitwarden 注册</button>
            </> : <>
              <Field label="姓名（可选）"><input type="text" autoComplete="name" maxLength={50} disabled={busy} value={name} onChange={event => setName(event.target.value)} className="field" /></Field>
              <button type="submit" disabled={busy} className="btn btn-primary w-full gap-2 py-2.5">{busy && <IconSpinner size={15} />}{busy ? '正在继续…' : '继续'}</button>
            </>}
          </form>
        </>}
        {step.kind === 'setPassword' && <>
          <p className="mb-5 mt-2 break-words text-sm text-[var(--ink-secondary)]">{email}<span className="mt-1 block text-xs text-[var(--ink-tertiary)]">{serverUrl}</span></p>
          <form onSubmit={event => { void submit(event); }} className="space-y-4">
            <Field label="主密码" hint="至少 12 个字符。请选择足够长、且未在其他网站使用的密码。"><input type="password" autoComplete="new-password" required minLength={12} autoFocus disabled={busy} value={password} onChange={event => setPassword(event.target.value)} className="field secret" /></Field>
            <Field label="确认主密码"><input type="password" autoComplete="new-password" required minLength={12} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} className="field secret" /></Field>
            <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">请牢记主密码。1Warden 无法找回你的主密码，也无法代你解密保险库。</p>
            <button type="submit" disabled={busy} className="btn btn-primary w-full gap-2 py-2.5">{busy && <IconSpinner size={15} />}{busy ? '正在创建账户…' : '创建账户'}</button>
            <button type="button" disabled={busy} className="btn btn-quiet w-full py-2" onClick={() => { setPassword(''); setConfirmation(''); setError(null); setStep({ kind: 'identity' }); }}>修改邮箱或服务器</button>
          </form>
        </>}
        {step.kind === 'verifyEmail' && <div className="mt-4 space-y-4">
          <p className="break-words text-sm leading-relaxed text-[var(--ink-secondary)]">如果 {email} 可以注册，你会收到服务器的验证邮件。点击邮件中的链接，在服务器网页中设置主密码并完成注册，再回到这里登录。</p>
          <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">未收到邮件？请检查垃圾邮件、确认邮箱地址，或联系服务器管理员。已有账户可以直接登录。</p>
          <button type="button" disabled={busy} className="btn btn-primary w-full py-2.5" onClick={() => { void leave('login'); }}>已完成注册，去登录</button>
          <button type="button" disabled={busy} className="btn btn-quiet w-full py-2" onClick={() => { setError(null); setStep({ kind: 'identity' }); }}>修改邮箱或重新发送</button>
        </div>}
        {step.kind === 'complete' && <div className="mt-4 space-y-4">
          <p className="break-words text-sm leading-relaxed text-[var(--ink-secondary)]">{email} 已在 {serverUrl} 注册。现在可以使用刚设置的主密码登录。</p>
          <button type="button" disabled={busy} className="btn btn-primary w-full py-2.5" onClick={() => { void leave('login'); }}>登录新账户</button>
        </div>}
        {step.kind !== 'complete' && <button type="button" disabled={busy} className="btn btn-ghost mt-5 w-full py-2 text-[var(--accent)]" onClick={() => { void leave('login'); }}>已有账户？登录</button>}
      </>}
      {error && <p role="alert" className="mt-4 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-sm text-[var(--risk)]">{error}</p>}
      {!cloudRegion && (step.kind === 'identity' || error) && <button type="button" disabled={busy || !serverUrl.trim()} className="btn btn-ghost mt-3 w-full py-2 text-xs" onClick={() => { void openWebVault(); }}>在服务器网页中注册</button>}
      <p className="mt-7 text-xs leading-relaxed text-[var(--ink-tertiary)]">主密码只在本地用于派生密钥，永不发送到服务器。{!cloudRegion && '是否开放注册、是否需要邮箱验证，由服务器管理员决定。'}</p>
    </div>
  </main>;
}
