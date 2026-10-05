import { useState, useEffect, useRef, type FormEvent } from 'react';
import type { VaultClient } from '@coffer/vault';
import { IconAlert, IconGlobe, IconSpinner } from '../components/icons';

interface Props {
  client: VaultClient;
  onUnlocked: () => void;
  onDisconnect: () => void;
}

/**
 * 已登录但被锁定时的解锁屏。
 *
 * 与连接屏的区别：这里已经有账户信息了，只需要主密码。
 * 这个区分很重要 —— 解锁是高频动作，不该每次都让用户面对一整张表单。
 *
 * ── 动效
 *
 * 这一屏只有一处动效：按下解锁之后，头像外圈开始缓缓扩散（`.breathe`），
 * 直到保险库出现。
 *
 * 它存在的理由是**等待**：派生密钥加一次网络往返接近一秒，
 * 界面在这段时间里完全不动的话，用户会以为没点上然后再点一次。
 * 所以动效回答的是「收到了，正在开」，而不是「看我会动」。
 *
 * 刻意没做「解锁成功再播一段动画然后才进保险库」：那会让每一次解锁都
 * 慢上半秒，而解锁是这个应用里最高频的动作。**该快的地方不快，
 * 就是在用别人的时间换自己的好看。** 进保险库的爽感由保险库本身的
 * 淡入承担（`.screen-in`）。
 */
export function Unlock({ client, onUnlocked, onDisconnect }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = client.getSession().account;
  const inputRef = useRef<HTMLInputElement>(null);

  // 解锁屏一出现就聚焦输入框 —— 用户按下快捷键后应该能直接开始打字
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.unlock(password);
      setPassword(''); // 成功后立刻从组件状态里清掉
      onUnlocked();
    } catch (err) {
      setError(messageOf(err));
      setPassword('');
      // 失败后把焦点还给输入框：用户下一步一定是重输
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    /* 整块背景可拖 —— 和连接屏同理，这一屏没有顶部带子（见 Connect.tsx） */
    <div className="below-titlebar flex h-full items-center justify-center overflow-y-auto bg-[var(--surface-canvas)] p-8" data-tauri-drag-region="deep">
      <div className="screen-in w-full max-w-[380px]">
        <div className="flex flex-col items-center text-center">
          {/* 头像位 —— 用邮箱首字母，不引入外部图片 */}
          <div
            className={`mb-4 grid h-16 w-16 place-items-center rounded-full bg-[var(--accent-tint)] text-[var(--text-xl)] font-semibold text-[var(--accent)] ${
              busy ? 'breathe' : ''
            }`}
            aria-hidden
          >
            {(account?.email ?? '?').slice(0, 1).toUpperCase()}
          </div>

          <p className="text-[var(--text-md)] font-medium">{account?.email}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            <IconGlobe size={12} className="shrink-0" />
            <span className="truncate">{hostOf(account?.serverUrl ?? '')}</span>
          </p>
        </div>

        <form onSubmit={submit} className="mt-7 space-y-3">
          <input
            ref={inputRef}
            id="unlock-password"
            type="password" required value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="主密码"
            aria-label="主密码"
            className="field secret py-2.5 text-center"
          />
          <button
            type="submit" disabled={busy || password.length === 0}
            className="btn btn-primary w-full py-2.5"
          >
            {busy && <IconSpinner size={15} />}
            {busy ? '解锁中…' : '解锁'}
          </button>
        </form>

        {error && (
          <p role="alert" className="mt-4 flex items-start justify-center gap-2 text-[var(--text-sm)] text-[var(--risk)]">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-9 text-center">
          <button
            onClick={onDisconnect}
            className="text-[var(--text-xs)] text-[var(--ink-tertiary)] underline-offset-2 transition-colors duration-[var(--dur-fast)] hover:text-[var(--ink-secondary)] hover:underline"
          >
            使用其他账户
          </button>
        </div>
      </div>
    </div>
  );
}

/** 只用于展示的主机名 —— 真正的解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function messageOf(err: unknown): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'network': return '连不上服务器';
    case 'timeout': return '服务器响应超时';
    case 'auth': return '主密码不正确';
    case 'rateLimited': return '尝试过于频繁，请稍后再试';
    default: return err instanceof Error ? err.message : '解锁失败';
  }
}
