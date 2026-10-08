import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import {
  IconAlert, IconChevronDown, IconGlobe, IconPlus, IconServer, IconSpinner,
} from './icons';
import { TwoFactorForm } from './TwoFactorForm';
import type { SavedAccount } from './accounts';
import { BackButton } from './PageHeader';

/**
 * 连接 / 解锁这一屏 —— **两端共用这一份**。
 *
 * ## 为什么必须共用
 *
 * 这份界面以前是两个 app 里各写一遍，而扩展端那份是**只有一小半**：
 *
 * | | 桌面端 | 弹窗（合并前） |
 * |---|---|---|
 * | 完整表单（地址 + 邮箱 + 主密码） | ✅ | ✅ |
 * | 服务器地址的示例提示 | ✅ | ❌ |
 * | **记住的账户列表** | ✅ | ❌ 完全没有 |
 * | **快速解锁**（点账户 → 只敲密码） | ✅ | ❌ 完全没有 |
 *
 * 后两行不是「样式不一致」：回访用户在这个自托管客户端上是**多数**，
 * 而弹窗让每一次都从头敲服务器地址和邮箱 —— 一个敲错了只会得到
 * 「连不上」的字段。同一族里这是第 10 件，和前面 9 件一样不会报错。
 *
 * ## 边界：`onConnect` 由调用方做，视图切换由这里做
 *
 * 平台专有的东西**不进这个文件**：
 *
 * - **证书确认**：桌面端走 Rust 的 `probeCertificate` / `trustCertificate`；
 *   扩展端没有这条路（TLS 校验在浏览器手里）。所以它是 `cert` 插槽。
 * - **连接动作本身**：桌面端直接调 `VaultClient`，扩展端发消息给后台。
 * - **忙碌 / 错误 / 两步验证挑战**：都由那个动作产生，所以由调用方持有，
 *   这里只负责显示。
 */

export interface ConnectCreds {
  serverUrl: string;
  email: string;
  masterPassword: string;
}

export function ConnectScreen({
  accounts,
  busy,
  error,
  challenge,
  cert,
  brand,
  onSubmit,
  onTwoFactor,
  onCertCancel,
  onTrustCert,
  initialCredentials,
  onCredentialsChange,
  onPickAccount,
  onBack,
  canGoBack = false,
}: {
  /** `null` = 还在读（见 `accounts.ts` 对 `null` 和 `[]` 区别的说明） */
  accounts: SavedAccount[] | null;
  busy: boolean;
  error: string | null;
  /** 两步验证的挑战 —— 它不是错误，是流程的下一步 */
  challenge: { providers: number[] } | null;
  /** 桌面端专有的证书确认那一屏。扩展端恒为 `undefined` */
  cert?: ReactNode;
  /** 桌面端有 1Warden 标；弹窗的壳里已经有了，不重复画 */
  brand?: ReactNode;
  onSubmit: (c: ConnectCreds) => void;
  onTwoFactor: (p: { code: string; provider: number; remember: boolean }) => void;
  onCertCancel?: () => void;
  onTrustCert?: () => void;
  initialCredentials?: Pick<ConnectCreds, 'serverUrl' | 'email'> | undefined;
  onCredentialsChange?: ((credentials: Pick<ConnectCreds, 'serverUrl' | 'email'>) => void) | undefined;
  onPickAccount?: (account: SavedAccount) => void;
  onBack?: () => void;
  canGoBack?: boolean;
}) {
  /*
   * 三档视图：
   *   pick —— 选一个记住的账户（有记住的账户时从这里开始）
   *   form —— 填完整的服务器地址 + 邮箱 + 主密码
   *   quick —— 已选定某个账户，只需要主密码
   *   null  —— **还没定**，账户还在读
   *
   * 这样回访用户是「点一下 + 敲密码」，第一次用的人是完整表单，
   * 两条路都不别扭。
   */
  const viewStore = useLocalStore(() => {
    const view = (initialCredentials ? 'form' : null) as 'pick' | 'form' | 'quick' | null;
    const serverUrl = initialCredentials?.serverUrl ?? '';
    const email = initialCredentials?.email ?? '';
    const password = '';
    return { view, serverUrl, email, password };
  });
  const [view, setView] = useStoreField(viewStore, 'view');
  const [serverUrl, setServerUrl] = useStoreField(viewStore, 'serverUrl');
  const [email, setEmail] = useStoreField(viewStore, 'email');
  const [password, setPassword] = useStoreField(viewStore, 'password');
  const returning = useRef(false);

  useEffect(() => {
    if (!returning.current && (view === 'form' || view === 'quick')) onCredentialsChange?.({ serverUrl, email });
  }, [serverUrl, email, view, onCredentialsChange]);

  /*
   * 账户读到之后再决定从哪一屏开始。
   *
   * ⚠️ 不能写成提前返回 —— 下面还有 hook（`passwordRef` 那个副作用），
   * 提前返回就是「有条件地调 hook」。占位放在 JSX 里。
   *
   * ⚠️ 也不能先渲染表单再跳：有记住账户的人会看到一张要填服务器地址的表单
   * 闪过去，读起来就是「我明明记住过」。
   */
  useEffect(() => {
    if (accounts === null || view !== null) return;
    const first = accounts[0];
    if (first) { setServerUrl(first.serverUrl); setEmail(first.email); }
    setView(first ? 'pick' : 'form');
  }, [accounts, view]);

  const passwordRef = useRef<HTMLInputElement>(null);
  // 进到 quick 视图时把焦点放到密码框 —— 用户点完账户就该直接打字
  useEffect(() => {
    if (view === 'quick') passwordRef.current?.focus();
  }, [view]);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ serverUrl: serverUrl.trim(), email: email.trim(), masterPassword: password });
  }

  const inFlow = cert !== undefined || challenge !== null;
  function goBack() {
    returning.current = true;
    setServerUrl(''); setEmail(''); setPassword('');
    setView(accounts?.length ? 'pick' : null);
    onBack?.();
  }

  return (
    <>
      {brand !== undefined && <div className="mb-7 flex items-center gap-2.5">{brand}</div>}

      {!inFlow && view !== null && (
        <h1 className="text-md font-medium text-[var(--ink-secondary)]">
          {view === 'pick' ? '选择要连接的账户' : '连接到你的 Vaultwarden'}
        </h1>
      )}

      <div className="mt-5">
        {(view === 'form' || inFlow) && (canGoBack || Boolean(accounts?.length)) && (
          <BackButton label="返回上一级" onBack={goBack} showLabel className="mb-4" />
        )}
        {view === null ? (
          /* 账户还在读。**不渲染表单** —— 见上面那个 effect 的说明 */
          <div className="h-[176px]" aria-hidden />
        ) : cert !== undefined ? (
          cert
        ) : challenge ? (
          <TwoFactorForm
            providers={challenge.providers}
            busy={busy}
            onSubmit={onTwoFactor}
          />
        ) : view === 'pick' ? (
          <AccountPicker
            /* `?? []` 只为类型收窄：`view === 'pick'` 只在 `accounts[0]`
               存在时才设上（见上面那个 effect），TS 追不到这条因果 */
            accounts={accounts ?? []}
            busy={busy}
            onPick={(a) => {
              if (busy) return;
              returning.current = false;
              if (onPickAccount) { onPickAccount(a); return; }
              setServerUrl(a.serverUrl);
              setEmail(a.email);
              setPassword('');
              setView('quick');
            }}
            onOther={() => { returning.current = false; setServerUrl(''); setEmail(''); setPassword(''); setView('form'); }}
          />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {view === 'quick' && (
              <AccountChip
                email={email}
                serverUrl={serverUrl}
                onBack={goBack}
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
                onClick={() => { setPassword(''); setView('form'); }}
                className="btn w-full py-2 text-xs text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]"
              >
                这台服务器上的其他账户
              </button>
            )}
          </form>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-sm text-[var(--risk)]">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}

      {!inFlow && view !== null && (
        <p className="mt-8 text-xs leading-relaxed text-[var(--ink-tertiary)]">
          主密码只在本地用于派生密钥，<strong className="font-medium">永不发送到服务器</strong>。
          {/* 只有在账户列表那一屏才说这句 —— 别的屏上用户还没被问过要不要记住 */}
          {view === 'pick' && '服务器地址和邮箱会留在本机，方便下次连接。'}
        </p>
      )}
    </>
  );
}

/**
 * 记住的账户列表。
 *
 * 面向的是「自己有服务器」的人 —— 他们最常做的事就是回到同一个地方。
 * 每一项给出**能用来区分的信息**：邮箱、服务器主机名。
 * 只显示邮箱是不够的（同一个人在两个服务器上常用同一个邮箱）。
 */
export function AccountPicker({ accounts, busy = false, onPick, onOther, renderIdentity }: {
  accounts: SavedAccount[];
  busy?: boolean;
  onPick: (a: SavedAccount) => void;
  onOther: () => void;
  /** Optional presentation only; credentials and remembered account storage stay unchanged. */
  renderIdentity?: (account: SavedAccount) => ReactNode;
}) {
  return (
    <div>
      <ul className="space-y-1.5">
        {accounts.map((a) => (
          <li key={`${a.serverUrl}|${a.email}`}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(a)}
              className="group flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-paper)] px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
            >
              {renderIdentity ? renderIdentity(a) : <AccountIdentity account={a} />}
              <IconChevronDown size={15} className="-rotate-90 shrink-0 text-[var(--ink-tertiary)]" />
            </button>
          </li>
        ))}
      </ul>

      <button type="button" data-add-server onClick={onOther} disabled={busy} className="btn btn-quiet mt-3 w-full gap-2 py-2.5">
        <IconPlus size={14} />
        {accounts.length ? '连接其他服务器' : '添加第一个服务器'}
      </button>
    </div>
  );
}

/** Shared identity layout; the host can supply a cached avatar/name without changing selection. */
export function AccountIdentity({ account, displayName, avatar }: {
  account: SavedAccount; displayName?: string | undefined; avatar?: ReactNode;
}) {
  return <>
    {avatar ?? <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-md font-semibold text-[var(--accent)]">
      {(displayName || account.email).slice(0, 1).toUpperCase()}
    </span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-md">{displayName || account.email}</span>
      {displayName && <span className="mt-0.5 block truncate text-xs text-[var(--ink-secondary)]">{account.email}</span>}
      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--ink-tertiary)]">
        <IconGlobe size={12} className="shrink-0" />
        <span className="truncate">{hostOf(account.serverUrl)}</span>
      </span>
    </span>
  </>;
}

/** 已选定账户时的摘要 —— 替代两个已经不需要再填的输入框 */
export function AccountChip({ email, serverUrl, onBack }: {
  email: string; serverUrl: string; onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-well)] px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-md font-semibold text-[var(--accent)]">
        {email.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-md">{email}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--ink-tertiary)]">
          <IconServer size={12} className="shrink-0" />
          <span className="truncate">{hostOf(serverUrl)}</span>
        </span>
      </span>
      <BackButton onBack={onBack} label="换一个账户" showLabel />
    </div>
  );
}

/** 带可见标签的字段 */
export function Field({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-[var(--ink-tertiary)]">{hint}</span>}
    </label>
  );
}

/** 只用于展示的主机名 —— 真正的 host:port 解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
