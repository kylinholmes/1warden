import { useState, useRef, useEffect, type FormEvent } from 'react';
import type { VaultClient, TwoFactorChallenge } from '@coffer/vault';
import { probeCertificate, trustCertificate, type CertInfo } from '../trust';
import {
  IconAlert, IconArrowLeft, IconChevronDown, IconGlobe, IconLock,
  IconPlus, IconServer, IconSpinner,
} from '../components/icons';

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

/**
 * ── 记住的账户
 *
 * 这是个**自托管**客户端，一个人手上常常不止一个地址（自己的机器、公司的、
 * 朋友的）。每次都把 URL 和邮箱从头敲一遍没有道理 —— 它们不是秘密，
 * 而且敲错服务器地址只会得到一句「连不上」，很难查。
 *
 * ⚠️ 存进去的**只有服务器地址和邮箱**，永远不存主密码、不存任何密钥。
 * 那两样东西只活在内存里，锁定就没了（这是 spec 的安全不变量）。
 *
 * 存的是**列表**而不是单个槽位：上一版只有一个 `coffer.serverUrl` /
 * `coffer.email`，换一个账户就把上一个冲掉了。
 */
const ACCOUNTS_KEY = 'coffer.accounts';
const LEGACY_URL_KEY = 'coffer.serverUrl';
const LEGACY_EMAIL_KEY = 'coffer.email';
const MAX_ACCOUNTS = 5;

interface Saved { serverUrl: string; email: string }

function isSaved(v: unknown): v is Saved {
  return typeof v === 'object' && v !== null
    && typeof (v as Saved).serverUrl === 'string' && (v as Saved).serverUrl.length > 0
    && typeof (v as Saved).email === 'string' && (v as Saved).email.length > 0;
}

function readAccounts(): Saved[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter(isSaved).slice(0, MAX_ACCOUNTS);
    }
    // 旧版本只存了一个槽位 —— 把它迁移成列表的第一项，
    // 用户升级后不会觉得「我明明记住过」
    const serverUrl = localStorage.getItem(LEGACY_URL_KEY);
    const email = localStorage.getItem(LEGACY_EMAIL_KEY);
    if (serverUrl && email) return [{ serverUrl, email }];
  } catch {
    // 存储被禁用或内容坏了 —— 当作没记住过，不值得打断连接流程
  }
  return [];
}

function rememberAccount(a: Saved): void {
  try {
    const rest = readAccounts().filter((x) => !(x.serverUrl === a.serverUrl && x.email === a.email));
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([a, ...rest].slice(0, MAX_ACCOUNTS)));
    // 顺带写一份旧键：万一用户回退到上一版，仍然能读到
    localStorage.setItem(LEGACY_URL_KEY, a.serverUrl);
    localStorage.setItem(LEGACY_EMAIL_KEY, a.email);
  } catch {
    // 存不下就算了 —— 记住账户是便利功能，不能因为它失败就挡住连接
  }
}

export function Connect({ client, onConnected }: Props) {
  // 只读一次。连接成功之前不重新读 —— 否则重渲染会跟着存储变
  const [accounts] = useState<Saved[]>(readAccounts);

  const [serverUrl, setServerUrl] = useState(accounts[0]?.serverUrl ?? '');
  const [email, setEmail] = useState(accounts[0]?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [cert, setCert] = useState<CertInfo | null>(null);

  /**
   * 三档视图：
   *   pick —— 选一个记住的账户（有记住的账户时从这里开始）
   *   form —— 填完整的服务器地址 + 邮箱 + 主密码
   *   quick —— 已选定某个账户，只需要主密码
   *
   * 这样回访用户是「点一下 + 敲密码」，第一次用的人是完整表单，
   * 两条路都不别扭。
   */
  const [view, setView] = useState<'pick' | 'form' | 'quick'>(
    accounts.length > 0 ? 'pick' : 'form',
  );

  const passwordRef = useRef<HTMLInputElement>(null);
  // 进到 quick 视图时把焦点放到密码框 —— 用户点完账户就该直接打字
  useEffect(() => {
    if (view === 'quick') passwordRef.current?.focus();
  }, [view]);

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
      rememberAccount({ serverUrl: serverUrl.trim(), email: email.trim() });
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

  function pickAccount(a: Saved) {
    setServerUrl(a.serverUrl);
    setEmail(a.email);
    setPassword('');
    setError(null);
    setView('quick');
  }

  // 两步验证和证书确认都盖过账户选择 —— 那时候连接已经在进行中了
  const inFlow = cert !== null || challenge !== null;

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--surface-canvas)] p-8">
      <div className="screen-in w-full max-w-[380px]">
        <div className="mb-7 flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-ink)]">
            <IconLock size={17} />
          </span>
          <span className="text-[var(--text-xl)] font-semibold tracking-[-0.01em]">Coffer</span>
        </div>

        {!inFlow && (
          <h1 className="text-[var(--text-md)] font-medium text-[var(--ink-secondary)]">
            {view === 'pick' ? '选择要连接的账户'
              : challenge ? '需要两步验证'
              : cert ? '需要确认服务器证书'
              : '连接到你的 Vaultwarden'}
          </h1>
        )}

        <div className="mt-5">
          {cert ? (
            <CertificatePrompt
              cert={cert}
              host={hostOf(serverUrl)}
              busy={busy}
              onCancel={() => setCert(null)}
              onTrust={trustAndRetry}
            />
          ) : challenge ? (
            <form onSubmit={submitCode} className="space-y-4">
              <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">
                可用方式：{challenge.providers.map((p) => PROVIDER_NAME[p] ?? `方式 ${p}`).join('、')}
              </p>
              <Field label="验证码">
                <input
                  type="text" required inputMode="numeric" autoFocus value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="field secret text-center text-[var(--text-xl)] tracking-[0.3em]"
                />
              </Field>
              <label className="flex items-center gap-2.5 text-[var(--text-sm)] text-[var(--ink-secondary)]">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                记住这台设备
              </label>
              <button type="submit" disabled={busy} className="btn btn-primary w-full py-2.5">
                {busy && <IconSpinner size={15} />}
                {busy ? '验证中…' : '验证'}
              </button>
            </form>
          ) : view === 'pick' ? (
            <AccountPicker
              accounts={accounts}
              onPick={pickAccount}
              onOther={() => { setServerUrl(''); setEmail(''); setPassword(''); setError(null); setView('form'); }}
            />
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {view === 'quick' && (
                <AccountChip
                  email={email}
                  serverUrl={serverUrl}
                  onBack={() => { setPassword(''); setError(null); setView('pick'); }}
                />
              )}

              {view === 'form' && (
                <>
                  <Field label="服务器地址" hint="例如 https://vault.example.com">
                    <input
                      type="url" required value={serverUrl} autoFocus
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://vault.example.com"
                      className="field"
                    />
                  </Field>
                  <Field label="邮箱">
                    <input
                      type="email" required value={email} autoFocus={Boolean(serverUrl)}
                      onChange={(e) => setEmail(e.target.value)}
                      className="field"
                    />
                  </Field>
                </>
              )}

              <Field label="主密码">
                <input
                  ref={passwordRef}
                  type="password" required value={password} disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field secret"
                />
              </Field>

              <button type="submit" disabled={busy} className="btn btn-primary w-full py-2.5">
                {busy && <IconSpinner size={15} />}
                {busy ? '正在解锁…' : '解锁'}
              </button>

              {view === 'quick' && (
                <button
                  type="button"
                  onClick={() => { setPassword(''); setError(null); setView('form'); }}
                  className="btn w-full py-2 text-[var(--text-xs)] text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]"
                >
                  这台服务器上的其他账户
                </button>
              )}
            </form>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--risk)]">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}

        {!cert && !inFlow && (
          <p className="mt-8 text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
            主密码只在本地用于派生密钥，<strong className="font-medium">永不发送到服务器</strong>。
            {view === 'pick' && '服务器地址和邮箱会留在本机，方便下次连接。'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 记住的账户列表。
 *
 * 面向的是「自己有服务器」的人 —— 他们最常做的事就是回到同一个地方。
 * 每一项给出**能用来区分的信息**：邮箱、服务器主机名。
 * 只显示邮箱是不够的（同一个人在两个服务器上常用同一个邮箱）。
 */
function AccountPicker({ accounts, onPick, onOther }: {
  accounts: Saved[];
  onPick: (a: Saved) => void;
  onOther: () => void;
}) {
  return (
    <div>
      <ul className="space-y-1.5">
        {accounts.map((a) => (
          <li key={`${a.serverUrl}|${a.email}`}>
            <button
              type="button"
              onClick={() => onPick(a)}
              className="group flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-paper)] px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[var(--text-md)] font-semibold text-[var(--accent)]">
                {a.email.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--text-md)]">{a.email}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                  <IconGlobe size={12} className="shrink-0" />
                  <span className="truncate">{hostOf(a.serverUrl)}</span>
                </span>
              </span>
              <IconChevronDown size={15} className="-rotate-90 shrink-0 text-[var(--ink-tertiary)]" />
            </button>
          </li>
        ))}
      </ul>

      <button type="button" onClick={onOther} className="btn btn-quiet mt-3 w-full gap-2 py-2.5">
        <IconPlus size={14} />
        连接其他服务器
      </button>
    </div>
  );
}

/** 已选定账户时的摘要 —— 替代两个已经不需要再填的输入框 */
function AccountChip({ email, serverUrl, onBack }: {
  email: string; serverUrl: string; onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-well)] px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[var(--text-md)] font-semibold text-[var(--accent)]">
        {email.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--text-md)]">{email}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
          <IconServer size={12} className="shrink-0" />
          <span className="truncate">{hostOf(serverUrl)}</span>
        </span>
      </span>
      <button
        type="button" onClick={onBack}
        className="btn btn-ghost shrink-0 gap-1.5" title="换一个账户"
      >
        <IconArrowLeft size={13} />
        更换
      </button>
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
      <p className="text-[var(--text-sm)] leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
        <strong className="font-medium text-[var(--ink-primary)]">{props.host}</strong>{' '}
        出示的证书无法验证。自建服务器用自签证书是正常的；但也可能是有人
        在中间截获了这次连接 —— 这两种情况从这边看不出来。
      </p>

      <dl className="card-well space-y-2.5 p-4 text-[var(--text-xs)]">
        <Row label="指纹">
          <span className="secret break-all text-[var(--text-xs)]">{cert.fingerprint}</span>
        </Row>
        <Row label="签发给"><span className="truncate">{cert.subject}</span></Row>
        <Row label="签发者"><span className="truncate">{cert.issuer}</span></Row>
        <Row label="有效期">
          <span className="tabular-nums">{shortDate(cert.notBefore)} 至 {shortDate(cert.notAfter)}</span>
        </Row>
      </dl>

      <p className="text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
        请与服务器管理员核对上面的指纹（服务器上执行{' '}
        <code className="secret">openssl x509 -noout -fingerprint -sha256 -in 证书文件</code>
        ）。核对一致才能继续。
      </p>

      <div className="flex flex-col gap-2 pt-1">
        <button type="button" onClick={props.onCancel} disabled={props.busy}
          className="btn btn-primary w-full py-2.5">
          取消
        </button>
        <button type="button" onClick={props.onTrust} disabled={props.busy}
          className="btn btn-quiet w-full gap-2 py-2.5 text-[var(--caution)]">
          {props.busy && <IconSpinner size={14} />}
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
      <span className="mb-1.5 block text-[var(--text-xs)] font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[var(--text-xs)] text-[var(--ink-tertiary)]">{hint}</span>}
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
