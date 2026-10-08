import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useEffect } from 'react';
import { IconSpinner } from '@1warden/ui';
import type { AppUpdater } from '../updates/controller';
import { desktopUpdater, desktopUpdatesSupported } from '../updates/desktop';

export default function AppUpdates({ updater: supplied }: { updater?: AppUpdater }) {
  const updater = supplied ?? desktopUpdater;
  const state = useStoreSnapshot(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
  const viewStore = useLocalStore(() => {
    const available = Boolean(supplied);
    return { available };
  });
  const [available, setAvailable] = useStoreField(viewStore, 'available');
  useEffect(() => {
    if (supplied) { setAvailable(true); return; }
    let alive = true;
    void desktopUpdatesSupported().then((supported) => { if (alive) setAvailable(supported); });
    return () => { alive = false; };
  }, [supplied]);
  if (!available) return null;

  const ready = state.phase === 'ready' || state.phase === 'restarting';
  const busy = ['checking', 'downloading', 'installing', 'restarting'].includes(state.phase);
  const percent = state.totalBytes ? Math.min(100, Math.floor(state.downloadedBytes / state.totalBytes * 100)) : null;
  const status = state.phase === 'idle' ? state.checkedAt === null ? '会在后台自动检查并准备更新。' : '已是最新版本。'
    : state.phase === 'checking' ? '正在检查更新…'
    : state.phase === 'downloading' ? `正在下载 ${state.targetVersion}${percent === null ? '…' : ` · ${percent}%`}`
    : state.phase === 'installing' ? '正在准备更新…'
    : state.phase === 'ready' ? `版本 ${state.targetVersion} 已准备好，重启后生效。也可以等下次打开。`
    : state.phase === 'restarting' ? '正在重启…' : null;

  return <section aria-labelledby="app-updates-heading" className="border-b border-[var(--border-subtle)] py-3">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-[120px] flex-1">
        <h4 id="app-updates-heading" className="text-md">应用更新</h4>
        <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">当前版本 {state.currentVersion ?? '正在读取…'}</p>
      </div>
      <button type="button" className={`btn ${ready ? 'btn-primary' : 'btn-quiet'} gap-1.5`} disabled={busy}
        onClick={() => { void (ready ? updater.restart() : updater.check()); }}>
        {busy && <IconSpinner size={13} />}
        {ready ? state.phase === 'restarting' ? '正在重启…' : '重启更新' : state.phase === 'error' ? '重试更新' : '检查更新'}
      </button>
    </div>
    {status && <p role="status" className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">{status}</p>}
    {state.phase === 'downloading' && <div role="progressbar" aria-label="下载更新" aria-valuemin={0} aria-valuemax={100}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-well)]">
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent ?? 0}%` }} />
    </div>}
    {state.error && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{state.error}</p>}
  </section>;
}
