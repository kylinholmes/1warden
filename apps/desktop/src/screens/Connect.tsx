import { useState, type FormEvent } from 'react';
import type { VaultClient, TwoFactorChallenge } from '../vault-client';
import { probeCertificate, trustCertificate, type CertInfo } from '../trust';

interface Props {
  client: VaultClient;
  onConnected: () => void;
}

function isTwoFactor(e: unknown): e is TwoFactorChallenge & { __twoFactor: true } {
  return typeof e === 'object' && e !== null && (e as { twoFactorRequired?: boolean }).twoFactorRequired === true;
}

function isCertUntrusted(e: unknown): e is { kind: 'certUntrusted'; fingerprint?: string } {
  return (e as { kind?: string } | null)?.kind === 'certUntrusted';
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
  const [cert, setCert] = useState<CertInfo | null>(null);

  /**
   * 真正的连接动作。抽出来是因为「信任证书」之后要原样重跑一遍 ——
   * 而那条路径上没有表单提交事件可用。
   */
  async function doConnect() {
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
      } else if (isCertUntrusted(err)) {
        await offerCertificate();
      } else {
        setError(messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * 证书验证失败时的处理。
   *
   * ⚠️ 这里**不**自动重试、也不自动信任：证书有问题既可能是自建服务器的
   * 自签证书（正常），也可能是有人在中间截获连接（危险）。这两种情况从
   * 客户端这边看不出来，只有用户自己知道那台服务器是不是他的。所以把
   * 证据摆出来，让用户拍板。
   */
  async function offerCertificate() {
    try {
      setCert(await probeCertificate(serverUrl.trim()));
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await doConnect();
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

  async function trustAndRetry() {
    if (!cert) return;
    setBusy(true);
    try {
      await trustCertificate(serverUrl.trim(), cert.fingerprint);
      setCert(null);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    await doConnect();
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-[var(--text-2xl)] font-semibold tracking-tight">Coffer</h1>
        <p className="mb-8 text-[var(--text-md)] text-[var(--ink-secondary)]">
          {cert ? '需要确认服务器证书' : challenge ? '需要两步验证' : '连接到你的 Vaultwarden'}
        </p>

        {cert ? (
          <CertificatePrompt
            cert={cert}
            host={hostOf(serverUrl)}
            busy={busy}
            onCancel={() => setCert(null)}
            onTrust={trustAndRetry}
          />
        ) : !challenge ? (
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

        {!cert && (
          <p className="mt-8 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            主密码只在本地用于派生密钥，<strong className="font-medium">永不发送到服务器</strong>。
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 证书确认。
 *
 * 设计取向：**危险的那个动作不做成默认按钮**。这里默认、显眼的选项是「取消」，
 * 「信任并继续」要用户主动去点。一排按钮里最顺手的那个不该是不可逆的选择。
 */
function CertificatePrompt(props: {
  cert: CertInfo;
  host: string;
  busy: boolean;
  onCancel: () => void;
  onTrust: () => void;
}) {
  const { cert } = props;
  return (
    <div className="space-y-4">
      <p className="text-[var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
        <strong className="font-medium text-[var(--ink-primary)]">{props.host}</strong>{' '}
        出示的证书无法验证。自建服务器用自签证书是正常的；但也可能是有人
        在中间截获了这次连接 —— 这两种情况从这边看不出来。
      </p>

      <dl className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--surface-raised)] p-4 text-[var(--text-xs)]"
        style={{ boxShadow: 'var(--elev-1)' }}>
        <Row label="指纹">
          <span className="secret break-all text-[var(--text-xs)]">{cert.fingerprint}</span>
        </Row>
        <Row label="签发给"><span className="truncate">{cert.subject}</span></Row>
        <Row label="签发者"><span className="truncate">{cert.issuer}</span></Row>
        <Row label="有效期">
          <span>{shortDate(cert.notBefore)} 至 {shortDate(cert.notAfter)}</span>
        </Row>
      </dl>

      <p className="text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
        请与服务器管理员核对上面的指纹（服务器上执行{' '}
        <code className="secret">openssl x509 -noout -fingerprint -sha256 -in 证书文件</code>
        ）。核对一致才能继续。
      </p>

      <div className="flex flex-col gap-2 pt-1">
        <button
          type="button" onClick={props.onCancel} disabled={props.busy}
          className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button" onClick={props.onTrust} disabled={props.busy}
          className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-4 py-2 font-medium text-[var(--caution)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
        >
          {props.busy ? '正在继续…' : '我已核对，信任这张证书并继续'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-14 shrink-0 text-[var(--ink-tertiary)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[var(--ink-secondary)]">{children}</dd>
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

/** 只用于展示的主机名 —— 真正的 host:port 解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Rust 侧给的是 RFC 2822 字符串；解析不了就原样显示，不要显示成 Invalid Date */
function shortDate(value: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toLocaleDateString('zh-CN');
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
    case 'certUntrusted': return '服务器证书无法验证';
    case 'server': return '服务器出错了';
    default: return err instanceof Error ? err.message : '未知错误';
  }
}
