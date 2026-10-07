import { useState, useSyncExternalStore } from 'react';
import type { AppUpdater } from '../updates/controller';
import { desktopUpdater } from '../updates/desktop';

/** A polite notification; it never takes focus, closes the app, or touches the vault. */
export default function AppUpdateNotice({ updater = desktopUpdater }: { updater?: AppUpdater }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const version = state.targetVersion;
  if (state.phase !== 'ready' || !version || dismissed.has(version)) return null;

  return <aside data-app-update-notice aria-label="应用更新提示"
    className="fixed right-4 bottom-4 z-[80] w-[min(360px,calc(100vw-32px))] rounded-[var(--radius-md)] border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-4 shadow-[var(--elev-pop)]">
    <div role="status" aria-live="polite" aria-atomic="true">
      <p className="text-md font-medium">新版本已准备好</p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-secondary)]">重启 1Warden 完成更新。也可以等下次打开。</p>
    </div>
    {state.error && <p role="alert" className="mt-2 text-sm text-[var(--risk)]">{state.error}</p>}
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className="btn btn-quiet" onClick={() => setDismissed((previous) => new Set([...previous, version]))}>稍后</button>
      <button type="button" className="btn btn-primary" onClick={() => { void updater.restart(); }}>重启更新</button>
    </div>
  </aside>;
}
