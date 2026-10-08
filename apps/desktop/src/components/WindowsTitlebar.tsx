import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getThemeMode, subscribeTheme } from '../theme';
import { BrandMark } from '@1warden/ui';

/** Native Windows main-window chrome; never mounted by extension/mobile/quick entries. */
export function WindowsTitlebar() {
  const viewStore = useLocalStore(() => {
    const maximized = false;
    const error = (null) as string | null;
    return { maximized, error };
  });
  const [maximized, setMaximized] = useStoreField(viewStore, 'maximized');
  const [error, setError] = useStoreField(viewStore, 'error');
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const theme = useStoreSnapshot(subscribeTheme, getThemeMode);
  useEffect(() => {
    let active = true;
    let off: (() => void) | undefined;
    const window = getCurrentWindow();
    const refresh = () => { void window.isMaximized().then(value => { if (active) setMaximized(value); }).catch(() => {}); };
    refresh();
    void window.onResized(refresh).then(unlisten => { if (active) off = unlisten; else unlisten(); }).catch(() => {});
    return () => { active = false; off?.(); };
  }, []);
  useEffect(() => {
    void invoke('window_theme', { theme: theme === 'system' ? null : theme }).catch(() => {});
  }, [theme]);
  async function action(action: 'minimize' | 'toggleMaximize' | 'close') {
    try { setError(null); setMaximized(await invoke<boolean>('window_action', { action })); }
    catch { setError('窗口操作失败，请重试'); }
  }
  return <header className="windows-titlebar" aria-label="窗口标题栏">
    <div className="windows-titlebar-drag" onDoubleClick={() => { void action('toggleMaximize'); }}
      onPointerDown={event => {
        if (event.button === 0) dragOrigin.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={event => {
        const start = dragOrigin.current;
        if (!start || !(event.buttons & 1)) return;
        // Entering the native drag loop on mouse-down can swallow the next click
        // on Windows 10/Acrylic. Only hand over a real movement, not a double-click.
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
        dragOrigin.current = null;
        void getCurrentWindow().startDragging().catch(() => setError('无法拖动窗口'));
      }}
      onPointerUp={() => { dragOrigin.current = null; }}
      onPointerCancel={() => { dragOrigin.current = null; }}
      onPointerLeave={() => { dragOrigin.current = null; }}>
      <BrandMark size={20} />
      <span>1Warden</span>
      {error && <span role="status" className="ml-3 text-[var(--risk)]">{error}</span>}
    </div>
    <div className="windows-window-controls">
      <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => { void action('minimize'); }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M1 6h10" /></svg>
      </button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => { void action('toggleMaximize'); }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          {maximized ? <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}
        </svg>
      </button>
      <button type="button" aria-label="关闭窗口" title="关闭至托盘" className="windows-close" onClick={() => { void action('close'); }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>
  </header>;
}
