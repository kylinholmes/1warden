import { useState, type FormEvent } from 'react';
import type { VaultClient, TwoFactorChallenge } from '../vault-client';

interface Props {
  client: VaultClient;
  onConnected: () => void;
}

function isTwoFactor(e: unknown): e is TwoFactorChallenge & { __twoFactor: true } {
  return typeof e === 'object' && e !== null && (e as { twoFactorRequired?: boolean }).twoFactorRequired === true;
}

/** 两步验证方式的名称 —— 数字来自官方枚举 */
const PROVIDER_NAME: Record<number, string> = {
  0: '验证器应用', 1: '邮箱', 2: 'Duo', 3: 'YubiKey',
  5: '记住的设备', 6: '组织 Duo', 7: '安全密钥', 8: '恢复代码',
};

export function Connect({ client, onConnected }: Props) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('coffer.serverUrl') ?? '');
  const [email, setEmail] = useState(() => localStorage.getItem('coffer.email') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.connect({ serverUrl: serverUrl.trim(), email: email.trim(), masterPassword: password });
      // 只记住服务器与邮箱 —— **绝不**记住主密码
      localStorage.setItem('coffer.serverUrl', serverUrl.trim());
      localStorage.setItem('coffer.email', email.trim());
      onConnected();
    } catch (err) {
      if (isTwoFactor(err)) {
        setChallenge({ providers: err.providers, providersInfo: err.providersInfo });
      } else {
        setError(messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.connectWithTwoFactor(code.trim(), challenge?.providers[0] ?? 0, remember);
      onConnected();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-[var(--text-2xl)] font-semibold tracking-tight">Coffer</h1>
        <p className="mb-8 text-[var(--text-md)] text-[var(--ink-secondary)]">
          {challenge ? '需要两步验证' : '连接到你的 Vaultwarden'}
        </p>

        {!challenge ? (
          <form onSubmit={submit} className="space-y-4">
            <Field label="服务器地址" hint="例如 https://vault.example.com">
              <input
                type="url" required value={serverUrl} autoFocus={!serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://vault.example.com"
                className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 outline-none focus:border-[var(--accent)]"
              />
            </Field>
            <Field label="邮箱">
              <input
                type="email" required value={email} autoFocus={Boolean(serverUrl)}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 outline-none focus:border-[var(--accent)]"
              />
            </Field>
            <Field label="主密码">
              <input
                type="password" required value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="secret w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 outline-none focus:border-[var(--accent)]"
              />
            </Field>

            <button
              type="submit" disabled={busy}
              className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {busy ? '正在解锁…' : '解锁'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">
              可用方式：{challenge.providers.map((p) => PROVIDER_NAME[p] ?? `方式 ${p}`).join('、')}
            </p>
            <Field label="验证码">
              <input
                type="text" required inputMode="numeric" autoFocus value={code}
                onChange={(e) => setCode(e.target.value)}
                className="secret w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-center text-[var(--text-xl)] tracking-[0.3em] outline-none focus:border-[var(--accent)]"
              />
            </Field>
            <label className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--ink-secondary)]">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              记住这台设备
            </label>
            <button
              type="submit" disabled={busy}
              className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {busy ? '验证中…' : '验证'}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-[var(--text-sm)] text-[var(--risk)]">
            {error}
          </p>
        )}

        <p className="mt-8 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
          主密码只在本地用于派生密钥，**永不发送到服务器**。
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[var(--text-sm)] font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[var(--text-xs)] text-[var(--ink-tertiary)]">{hint}</span>}
    </label>
  );
}

/** 把 ApiError 变成用户能看懂的话 —— 区分「密码错」和「连不上」是解锁屏的明确要求 */
function messageOf(err: unknown): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'network': return '连不上服务器，请检查地址与网络';
    case 'timeout': return '服务器响应超时';
    case 'auth': return '邮箱或主密码不正确';
    case 'rateLimited': return '尝试过于频繁，请稍后再试';
    case 'malformedResponse': return '服务器返回了无法理解的响应，可能不是 Vaultwarden';
    case 'server': return '服务器出错了';
    default: return err instanceof Error ? err.message : '未知错误';
  }
}
