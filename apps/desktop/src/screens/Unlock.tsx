import { useState, useEffect, type FormEvent } from 'react';
import type { VaultClient } from '../vault-client';

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
 */
export function Unlock({ client, onUnlocked, onDisconnect }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = client.getSession().account;

  // 解锁屏一出现就聚焦输入框 —— 用户按下快捷键后应该能直接开始打字
  useEffect(() => {
    document.getElementById('unlock-password')?.focus();
  }, []);

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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-xs text-center">
        {/* 头像位 —— 用邮箱首字母，不引入外部图片 */}
        <div
          className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-[var(--accent-tint)] text-[var(--text-xl)] font-medium text-[var(--accent)]"
          aria-hidden
        >
          {(account?.email ?? '?').slice(0, 1).toUpperCase()}
        </div>

        <p className="mb-1 text-[var(--text-md)] font-medium">{account?.email}</p>
        <p className="mb-6 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{account?.serverUrl}</p>

        <form onSubmit={submit} className="space-y-3">
          <input
            id="unlock-password"
            type="password" required value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="主密码"
            className="secret w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-center outline-none focus:border-[var(--accent)] disabled:opacity-50"
          />
          <button
            type="submit" disabled={busy || password.length === 0}
            className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {busy ? '解锁中…' : '解锁'}
          </button>
        </form>

        {error && (
          <p className="mt-3 text-[var(--text-sm)] text-[var(--risk)]">{error}</p>
        )}

        <button
          onClick={onDisconnect}
          className="mt-8 text-[var(--text-xs)] text-[var(--ink-tertiary)] underline-offset-2 hover:underline"
        >
          使用其他账户
        </button>
      </div>
    </div>
  );
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
