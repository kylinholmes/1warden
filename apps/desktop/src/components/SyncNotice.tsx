import { IconAlert, IconSpinner } from '@1warden/ui';
import type { ApplicationClient, ApplicationSnapshot } from '../application/types';

export function SyncNotice({ session, client }: { session: ApplicationSnapshot; client: ApplicationClient }) {
  if (!session.syncError) return null;
  return <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-well)] px-4 py-3 text-sm">
    <IconAlert size={16} className="mt-0.5 shrink-0 text-[var(--caution)]" />
    <div className="min-w-0 flex-1">
      <p className="font-medium text-[var(--caution)]">同步未完成</p>
      <p className="break-words text-xs text-[var(--ink-secondary)]">{session.syncError}</p>
      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">{session.items.length
        ? '当前显示已有数据，可能不是最新版本。' : '尚不能确认保险库内容，请重试同步。'}
        {session.lastSyncedAt && <> 上次成功：{new Date(session.lastSyncedAt).toLocaleString()}</>}</p>
    </div>
    <button type="button" className="btn btn-quiet shrink-0" disabled={session.syncing}
      onClick={() => { void client.sync().catch(() => { /* snapshot retains the retry failure */ }); }}>
      {session.syncing && <IconSpinner size={13} />}{session.syncing ? '同步中…' : '重试同步'}
    </button>
  </div>;
}
