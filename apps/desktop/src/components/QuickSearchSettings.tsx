import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { quickShortcut } from '../platform';
interface Status { enabled: boolean; shortcutError: string | null }
export default function QuickSearchSettings() {
  const viewStore = useLocalStore(() => {
    const status = (null) as Status | null;
    const busy = false;
    const error = (null) as string | null;
    return { status, busy, error };
  });
  const [status, setStatus] = useStoreField(viewStore, 'status');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [error, setError] = useStoreField(viewStore, 'error');
  useEffect(() => {
    let alive = true;
    void invoke<Status>('quick_status').then(value => { if (alive) setStatus(value); })
      .catch(() => { if (alive) setError('无法读取快速搜索设置'); });
    return () => { alive = false; };
  }, []);
  async function toggle() {
    if (!status || busy) return;
    setBusy(true); setError(null);
    try { setStatus(await invoke<Status>('quick_set_enabled', { enabled: !status.enabled })); }
    catch (cause) { setError(typeof cause === 'string' ? cause : '无法保存设置，请重试'); }
    finally { setBusy(false); }
  }
  return <section className="mt-6">
    <h3 className="text-md font-medium">快速搜索</h3>
    <div className="card mt-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1"><p id="quick-setting-label" className="text-md">启用快速搜索</p>
          <p className="mt-1 text-xs text-[var(--ink-tertiary)]">使用 {quickShortcut()} 或托盘打开；关闭后释放快捷键</p></div>
        <button type="button" role="switch" aria-labelledby="quick-setting-label" aria-checked={status?.enabled ?? false}
          disabled={!status || busy} onClick={() => { void toggle(); }} className="quick-setting-toggle"><span /></button>
      </div>
      <p className="mt-3 text-xs text-[var(--ink-tertiary)]">点击外部自动收起。窗口右上角可临时固定，再次打开恢复默认。</p>
      {(error || status?.shortcutError) && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{error || status?.shortcutError}</p>}
    </div>
  </section>;
}
