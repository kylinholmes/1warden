import { useEffect, useRef } from 'react';
import { ProfileAvatar } from './ProfileAvatar';
import type { QuickAccount } from '../quick-bridge';

export function QuickLockedAccounts({ accounts, busy, onOpenAccount }: {
  accounts: readonly QuickAccount[]; busy: boolean; onOpenAccount?: ((id: string | null) => void) | undefined;
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
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = element.scrollWidth - element.clientWidth;
      if (max <= 0) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
      const next = Math.min(max, Math.max(0, element.scrollLeft + delta));
      if (next === element.scrollLeft) return;
      event.preventDefault(); element.scrollLeft = next;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  return <section aria-label="选择要解锁的账户" className="flex min-h-0 flex-1 flex-col justify-center gap-2 py-3">
    <div className="px-6 text-center">
      <h1 className="text-md font-medium">选择账户解锁</h1>
    </div>
    <div ref={rail} data-quick-account-rail className="flex h-48 shrink-0 items-center gap-3 overflow-x-auto overflow-y-hidden px-6 py-4"
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        const next = event.key === 'ArrowRight' ? Math.min(buttons.length - 1, current + 1)
          : event.key === 'ArrowLeft' ? Math.max(0, current - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}>
      {accounts.map(account => <button key={account.id} type="button" data-quick-account={account.id}
        disabled={busy || !onOpenAccount} onClick={() => onOpenAccount?.(account.id)}
        title={`${account.displayName || account.email}\n${account.email}\n${account.serverUrl}`}
        aria-label={`前往解锁 ${account.displayName || account.email} · ${account.email} · ${account.serverUrl}`}
        className="group flex h-40 w-44 shrink-0 flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] px-2 py-2 text-center first:ml-auto last:mr-auto hover:bg-[var(--surface-hover)] focus-visible:outline-none disabled:opacity-60">
        <span className="shrink-0 rounded-full transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-[var(--accent)] group-focus-visible:ring-offset-4 group-focus-visible:ring-offset-[var(--surface-overlay)] motion-reduce:transition-none">
          <ProfileAvatar profile={{ displayName: account.displayName, avatarDataUrl: account.avatarDataUrl }} fallback={account.email} className="h-[88px] w-[88px] text-3xl" />
        </span>
        <span data-quick-account-label className="block w-full shrink-0 truncate text-sm leading-6 font-medium">{account.email || account.displayName}</span>
      </button>)}
      {accounts.length === 0 && <div className="flex w-full flex-col items-center gap-4 py-5">
        <p role="status" className="text-sm text-[var(--ink-secondary)]">{busy ? '正在读取账户…' : '还没有记住的账户'}</p>
        <button type="button" className="btn btn-primary" disabled={busy || !onOpenAccount} onClick={() => onOpenAccount?.(null)}>打开 1Warden 登录</button>
      </div>}
    </div>
  </section>;
}
