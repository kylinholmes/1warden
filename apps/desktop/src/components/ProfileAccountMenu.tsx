import { useEffect, useRef, useState } from 'react';
import type { UserProfile } from '@coffer/vault';
import {
  host, readAccounts, IconArrowLeft, IconCheck, IconChevronDown, IconGear, IconIdentity,
  IconPlus, IconSpinner, type SavedAccount,
} from '@coffer/ui';
import { createProfileCache } from '../application/profile-cache';
import { ProfileAvatar } from './ProfileAvatar';

/** A server and email together identify an account, including its presentation cache. */
export interface ProfileAccount { serverUrl: string; email: string; profile: UserProfile | null }
export const profileAccountKey = (account: Pick<ProfileAccount, 'serverUrl' | 'email'>): string =>
  JSON.stringify([account.serverUrl.trim().replace(/\/$/, ''), account.email.trim().toLowerCase()]);

export interface ProfileAccountMenuProps {
  account: ProfileAccount;
  unlockedAccounts?: readonly string[];
  syncing: boolean;
  onProfile: () => void;
  onSettings: () => void;
  onLogout: () => Promise<void>;
  onSwitch: (account: SavedAccount | null) => Promise<void>;
}

const actionClass = 'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left text-sm hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] disabled:opacity-50';

export function ProfileAccountMenu({ account, unlockedAccounts = [], syncing, onProfile, onSettings, onLogout, onSwitch }: ProfileAccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<ProfileAccount[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const key = profileAccountKey(account);
  const name = account.profile?.displayName || account.email.split('@')[0] || '我的账户';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAccounts(null);
    void (async () => {
      const cache = createProfileCache(host().storage);
      const saved = await readAccounts();
      const seen = new Set([key]);
      const unique = saved.filter((entry) => {
        const entryKey = profileAccountKey(entry);
        if (seen.has(entryKey)) return false;
        seen.add(entryKey);
        return true;
      });
      const loaded = await Promise.all(unique.map(async (entry) => ({ ...entry, profile: await cache.load(entry) })));
      if (alive) setAccounts(loaded);
    })().catch(() => { if (alive) { setAccounts([]); setError('无法读取已保存的账户，请重试。'); } });
    return () => { alive = false; };
  }, [open, key]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function focusAction(last = false): void {
    requestAnimationFrame(() => {
      const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      if (buttons?.length) buttons[last ? buttons.length - 1 : 0]?.focus();
    });
  }
  function closeAndRun(action: () => void): void {
    if (pending.current) return;
    setOpen(false);
    trigger.current?.focus();
    action();
  }
  async function perform(label: string, action: () => Promise<void>): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    // Move focus before disabling the chosen button so its blur cannot dismiss the menu.
    menu.current?.focus();
    setBusy(label);
    setError(null);
    try {
      await action();
      if (mounted.current) { setOpen(false); trigger.current?.focus(); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  return <div ref={root} className="relative min-w-0 flex-1" data-account-key={key}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (!open || event.target === trigger.current) {
        setError(null); setOpen(true); focusAction(event.key === 'ArrowUp' || event.key === 'End'); return;
      }
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }} onBlur={(event) => {
      if (!pending.current && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
    <button ref={trigger} type="button" aria-label="账户菜单" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? 'profile-account-menu' : undefined}
      onClick={() => { setError(null); setOpen((value) => !value); if (!open) focusAction(); }}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 text-left hover:bg-[var(--surface-hover)]">
      <ProfileAvatar profile={account.profile} fallback={account.email} className="h-8 w-8 text-md" />
      <span className="min-w-0 flex-1 truncate text-md font-semibold" title={name}>{name}</span>
      {syncing ? <IconSpinner size={14} aria-label="正在同步" className="text-[var(--accent)]" />
        : <IconChevronDown size={14} className={`shrink-0 text-[var(--ink-secondary)] transition-transform ${open ? 'rotate-180' : ''}`} />}
    </button>
    {open && <div ref={menu} id="profile-account-menu" role="menu" tabIndex={-1} aria-label="账户操作" aria-busy={busy !== null}
      className="absolute left-0 top-full z-40 mt-1 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-2 shadow-[var(--elev-pop)]"
      style={{ width: 'min(320px, calc(100vw - 28px))', maxHeight: 'calc(100dvh - var(--titlebar-h, 0px) - var(--band-h) - max(20px, env(safe-area-inset-bottom, 0px) + 8px))' }}>
      <div className="mb-1 rounded-[var(--radius-sm)] bg-[var(--accent-tint)] px-2 py-2.5">
        <span className="sr-only">当前账户</span>
        <div className="flex items-center gap-2">
          <ProfileAvatar profile={account.profile} fallback={account.email} className="h-8 w-8 text-sm" />
          <span className="min-w-0 flex-1 break-words text-sm font-medium">{name}</span>
          <IconCheck size={15} className="shrink-0 text-[var(--accent)]" />
        </div>
        <p className="mt-2 break-all text-xs text-[var(--ink-primary)]">{account.email}</p>
        <p className="mt-0.5 break-all text-2xs text-[var(--ink-secondary)]">{account.serverUrl}</p>
      </div>
      {accounts === null ? <p role="status" className="px-2 py-2 text-xs text-[var(--ink-secondary)]">正在读取账户…</p>
        : accounts.length > 0 && <>
          <p className="px-2 pt-2 pb-1 text-2xs font-medium text-[var(--ink-secondary)]">切换账户</p>
          {accounts.map((entry) => <button key={profileAccountKey(entry)} data-switch-account={profileAccountKey(entry)}
            type="button" role="menuitem" tabIndex={-1} disabled={busy !== null} className={actionClass}
            onClick={() => { void perform('正在切换账户…', () => onSwitch({ serverUrl: entry.serverUrl, email: entry.email })); }}>
            <ProfileAvatar profile={entry.profile} fallback={entry.email} className="h-7 w-7 text-sm" />
            <span className="min-w-0 flex-1">
              {entry.profile?.displayName && <span className="block break-words font-medium">{entry.profile.displayName}</span>}
              <span className="block break-all text-xs">{entry.email}</span>
              <span className="mt-0.5 block break-all text-2xs text-[var(--ink-secondary)]">{entry.serverUrl}</span>
              <span className="mt-0.5 block text-2xs text-[var(--ink-secondary)]">
                {unlockedAccounts.includes(profileAccountKey(entry)) ? '已解锁' : '需要验证'}
              </span>
            </span>
          </button>)}
        </>}
      <button type="button" role="menuitem" tabIndex={-1} disabled={busy !== null} className={actionClass}
        onClick={() => { void perform('正在打开登录…', () => onSwitch(null)); }}>
        <IconPlus size={16} className="text-[var(--accent)]" />添加账户
      </button>
      <div role="separator" className="my-1 border-t border-[var(--border-subtle)]" />
      <button type="button" role="menuitem" tabIndex={-1} disabled={busy !== null} className={actionClass} onClick={() => closeAndRun(onProfile)}>
        <IconIdentity size={16} className="text-[var(--accent)]" />更新头像与资料
      </button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={busy !== null} className={actionClass} onClick={() => closeAndRun(onSettings)}>
        <IconGear size={16} className="text-[var(--violet)]" />设置
      </button>
      <div role="separator" className="my-1 border-t border-[var(--border-subtle)]" />
      <button type="button" role="menuitem" tabIndex={-1} disabled={busy !== null} className={`${actionClass} text-[var(--risk)]`}
        onClick={() => { void perform('正在登出…', onLogout); }}>
        <IconArrowLeft size={16} className="rotate-180" />登出
      </button>
      {busy && <p role="status" className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--accent)]"><IconSpinner size={13} />{busy}</p>}
      {error && <p role="alert" className="px-2 py-2 text-xs text-[var(--risk)]">{error}</p>}
    </div>}
  </div>;
}
