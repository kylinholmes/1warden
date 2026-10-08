import { useLocalStore, useStoreField } from '@1warden/state/react';
/** Quick owns only summaries and presentation; the main window owns the session. */
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickAccess } from '../screens/QuickAccess';
import { iconStoreFor } from '@1warden/ui';
import { initPlatform } from '../platform';
import { installDesktopHost } from '../host-impl';
import { initNativeFeel } from '../native';
import { initTheme } from '../theme';
import { askMain, askAction, onResults, onActionResult, type QuickItem } from '../quick-bridge';
import '../styles.css';

function Quick() {
  const viewStore = useLocalStore(() => {
    const items = ([]) as QuickItem[];
    const locked = true;
    const busy = false;
    const notice = (null) as string | null;
    const pinned = false;
    const generation = 0;
    const serverUrl = (null) as string | null;
    return { items, locked, busy, notice, pinned, generation, serverUrl };
  });
  const [items, setItems] = useStoreField(viewStore, 'items');
  const [locked, setLocked] = useStoreField(viewStore, 'locked');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [notice, setNotice] = useStoreField(viewStore, 'notice');
  const [pinned, setPinned] = useStoreField(viewStore, 'pinned');
  const [generation, setGeneration] = useStoreField(viewStore, 'generation');
  const [serverUrl, setServerUrl] = useStoreField(viewStore, 'serverUrl');
  const state = useRef({ seq: 0, generation: -1, query: '', pinned: false, action: 0, pending: false });

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const remember = (off: () => void) => { if (disposed) off(); else unlisteners.push(off); };
    const failure = () => { if (!disposed) { setBusy(false); setNotice('暂时无法连接主窗口，请重试'); } };
    async function refresh() {
      const next = await invoke<{ pinned: boolean; generation: number }>('quick_window_state');
      if (disposed || next.generation < state.current.generation) return;
      if (next.generation !== state.current.generation) {
        clearTimeout(closeTimer); state.current.query = ''; state.current.action++; state.current.pending = false;
        state.current.generation = next.generation; setGeneration(next.generation); setNotice(null); setItems([]);
      }
      state.current.pinned = next.pinned; setPinned(next.pinned);
      setBusy(true); await askMain(state.current.query, ++state.current.seq);
    }
    // Install replies first, then request data. Dispose late subscriptions too (StrictMode).
    void (async () => {
      remember(await onResults(result => {
        if (disposed || result.seq !== state.current.seq) return;
        setItems(result.items); setLocked(result.locked); setBusy(state.current.pending); setServerUrl(result.serverUrl);
      }));
      remember(await onActionResult(result => {
        if (disposed || result.requestId !== state.current.action || !state.current.pending) return;
        state.current.pending = false; setBusy(false); setNotice(result.message);
        if (result.ok && !state.current.pinned) {
          const currentGeneration = state.current.generation;
          closeTimer = setTimeout(() => {
            if (!disposed && currentGeneration === state.current.generation && !state.current.pinned) void invoke('quick_hide');
          }, 350);
        }
      }));
      remember(await listen('1warden:quick-open', () => { void refresh().catch(failure); }));
      remember(await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) void refresh().catch(failure);
      }));
      if (!disposed) await refresh();
    })().catch(failure);
    return () => { disposed = true; clearTimeout(closeTimer); for (const off of unlisteners) off(); };
  }, []);

  return <QuickAccess key={generation} items={items} icons={serverUrl === null ? null : iconStoreFor(serverUrl)}
    locked={locked} busy={busy} notice={notice} pinned={pinned}
    onTogglePin={() => {
      void invoke<boolean>('quick_set_pinned', { pinned: !state.current.pinned }).then(value => {
        state.current.pinned = value; setPinned(value);
      }).catch(() => setNotice('无法更改固定状态，请重试'));
    }}
    onQueryChange={query => {
      state.current.query = query; setBusy(true);
      void askMain(query, ++state.current.seq).catch(() => { setBusy(false); setNotice('搜索失败，请重试'); });
    }}
    onPick={item => {
      if (!item.hasPassword || state.current.pending) return;
      state.current.pending = true; setNotice(null); setBusy(true);
      void askAction(item.id, 'copy-password', ++state.current.action).catch(() => {
        state.current.pending = false; setBusy(false); setNotice('复制失败，请重试');
      });
    }}
    onClose={() => { void invoke('quick_hide'); }} />;
}

installDesktopHost();
initTheme(); initPlatform(); initNativeFeel();
createRoot(document.getElementById('root')!).render(<StrictMode><Quick /></StrictMode>);
