import { useEffect, useRef } from 'react';
import { ProfileAvatar } from './ProfileAvatar';
import type { QuickAccount } from '../quick-bridge';

export function QuickLockedAccounts({ accounts, busy, onOpenAccount, activeId, sidebar = false }: {
  accounts: readonly QuickAccount[]; busy: boolean; onOpenAccount?: ((id: string | null) => void) | undefined;
  activeId?: string | undefined; sidebar?: boolean;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const identity = accounts.map(account => account.id).join('\n');
  useEffect(() => {
    // Metadata refreshes must not steal focus from another card or the pin button.
    const current = document.activeElement;
    if (!current || current === document.body || current.classList.contains('quick-panel')) {
      rail.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [identity, busy]);
  return <section aria-label="选择要解锁的账户" className={`quick-accounts ${sidebar ? '' : 'quick-account-standalone'}`}>
    {!sidebar && <h1>选择账户</h1>}
    <div ref={rail} data-quick-account-rail className="quick-account-list"
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, current + 1)
          : event.key === 'ArrowUp' ? Math.max(0, current - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: 'nearest' });
      }}>
      {accounts.map(account => <button key={account.id} type="button" data-quick-account={account.id}
        disabled={busy || !onOpenAccount} onClick={() => onOpenAccount?.(account.id)}
        aria-current={activeId === account.id ? 'true' : undefined}
        title={`${account.displayName || account.email}\n${account.email}\n${account.serverUrl}`}
        aria-label={`选择账户 ${account.displayName || account.email} · ${account.email} · ${account.serverUrl}`}
        className="quick-account-row">
        <ProfileAvatar profile={{ displayName: account.displayName, avatarDataUrl: account.avatarDataUrl }} fallback={account.email} className="h-10 w-10 text-sm" />
        <span className="quick-account-copy">
          <span data-quick-account-label>{account.displayName || account.email}</span>
          {account.displayName && <span>{account.email}</span>}
          <span data-quick-account-server title={account.serverUrl}>{serverLabel(account.serverUrl)}</span>
        </span>
      </button>)}
      {accounts.length === 0 && <div className="quick-accounts-empty">
        <p role="status" className="text-sm text-[var(--ink-secondary)]">{busy ? '正在读取账户…' : '还没有记住的账户'}</p>
        <button type="button" className="btn btn-primary" disabled={busy || !onOpenAccount} onClick={() => onOpenAccount?.(null)}>打开 1Warden 登录</button>
      </div>}
    </div>
    {accounts.length > 0 && onOpenAccount && <button type="button" className="btn btn-ghost quick-accounts-login" disabled={busy}
      onClick={() => onOpenAccount(null)}>登录其他账户</button>}
  </section>;
}

function serverLabel(value: string) {
  try { const url = new URL(value); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return value; }
}
