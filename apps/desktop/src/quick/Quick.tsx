import { useLocalStore, useStoreField } from '@1warden/state/react';
/** Quick owns only summaries and presentation; the main window owns the session. */
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickAccess } from '../screens/QuickAccess';
import { iconStoreFor } from '@1warden/ui';
import { askMain, askAction, askOpenAccount, onResults, onActionResult, type QuickItem, type QuickAccount } from '../quick-bridge';
import { requestQuickAuth, cancelQuickAuth, onQuickAuthResult, onQuickAuthCancelled, type QuickAuthResult } from '../quick-auth';

export function Quick() {
  const viewStore = useLocalStore(() => {
    const items = ([]) as QuickItem[];
    const accounts = [] as QuickAccount[];
    const locked = true;
    const busy = false;
    const notice = (null) as string | null;
    const pinned = false;
    const generation = 0;
    const serverUrl = (null) as string | null;
    return { items, accounts, locked, busy, notice, pinned, generation, serverUrl, authReset: 0,
      syncing: false, syncError: null as string | null, authError: null as string | null, activeAccount: null as { email: string; serverUrl: string } | null };
  });
  const [items, setItems] = useStoreField(viewStore, 'items');
  const [accounts, setAccounts] = useStoreField(viewStore, 'accounts');
  const [locked, setLocked] = useStoreField(viewStore, 'locked');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [notice, setNotice] = useStoreField(viewStore, 'notice');
  const [pinned, setPinned] = useStoreField(viewStore, 'pinned');
  const [generation, setGeneration] = useStoreField(viewStore, 'generation');
  const [serverUrl, setServerUrl] = useStoreField(viewStore, 'serverUrl');
  const [authReset, setAuthReset] = useStoreField(viewStore, 'authReset');
  const [syncing, setSyncing] = useStoreField(viewStore, 'syncing');
  const [syncError, setSyncError] = useStoreField(viewStore, 'syncError');
  const [activeAccount, setActiveAccount] = useStoreField(viewStore, 'activeAccount');
  const [authError, setAuthError] = useStoreField(viewStore, 'authError');
  const state = useRef({ seq: 0, generation: -1, query: '', pinned: false, action: 0, pending: false });
  const auth = useRef<{ requestId: number; generation: number; accountId: string;
    resolve: (value: QuickAuthResult) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  function clearAuthentication() {
    const current = auth.current; auth.current = null;
    if (current) { clearTimeout(current.timer); current.reject(new Error('本次解锁已取消')); }
  }
  function cancelAuthentication() {
    setAuthError(null);
    clearAuthentication();
    void cancelQuickAuth(state.current.generation).catch(() => {});
  }

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
        setAuthError(null);
        clearAuthentication();
        clearTimeout(closeTimer); state.current.query = ''; state.current.action++; state.current.pending = false;
        state.current.generation = next.generation; setGeneration(next.generation); setNotice(null); setItems([]); setAccounts([]); setLocked(true);
      }
      state.current.pinned = next.pinned; setPinned(next.pinned);
      setBusy(true); await askMain(state.current.query, ++state.current.seq);
    }
    // Install replies first, then request data. Dispose late subscriptions too (StrictMode).
    void (async () => {
      remember(await onResults(result => {
        if (disposed || result.seq !== state.current.seq) return;
        setItems(result.items); setAccounts(result.accounts ?? []);
        setSyncing(Boolean(result.syncing)); setSyncError(result.syncError ?? null); setActiveAccount(result.activeAccount ?? null);
        // Vault status changes before native authentication acceptance. Keep
        // the form mounted until its own accepted result completes the journey;
        // otherwise its unmount cleanup would cancel the just-finished unlock.
        if (result.locked || !auth.current) setLocked(result.locked);
        setBusy(state.current.pending || Boolean(result.accountsLoading)); setServerUrl(result.serverUrl);
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
      remember(await onQuickAuthResult(result => {
        const current = auth.current;
        if (disposed || !current || result.requestId !== current.requestId || result.generation !== current.generation
          || result.generation !== state.current.generation || result.accountId !== current.accountId) return;
        auth.current = null; clearTimeout(current.timer); current.resolve(result);
      }));
      remember(await onQuickAuthCancelled(result => {
        if (disposed || result.generation !== state.current.generation || result.requestId !== state.current.action) return;
        if (result.expired) setAuthError('解锁服务响应超时，请重试');
        clearAuthentication(); setAuthReset(value => value + 1);
      }));
      remember(await listen('1warden:quick-open', () => { void refresh().catch(failure); }));
      remember(await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) void refresh().catch(failure);
      }));
      if (!disposed) await refresh();
    })().catch(failure);
    return () => { disposed = true; clearAuthentication(); clearTimeout(closeTimer); for (const off of unlisteners) off(); };
  }, []);

  return <QuickAccess key={generation} items={items} icons={serverUrl === null ? null : iconStoreFor(serverUrl)}
    locked={locked} accounts={accounts} busy={busy} notice={notice} pinned={pinned} authReset={authReset}
    authError={authError}
    syncing={syncing} syncError={syncError} activeAccount={activeAccount}
    onRetrySync={() => { void askMain(state.current.query, ++state.current.seq, false, true).catch(() => setNotice('无法重试同步，请稍后再试')); }}
    onAuthenticate={(accountId, input) => {
      clearAuthentication(); setNotice(null); setAuthError(null);
      const requestId = ++state.current.action;
      const currentGeneration = state.current.generation;
      return new Promise<QuickAuthResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (auth.current?.requestId !== requestId) return;
          setAuthError('解锁响应超时，请重试');
          auth.current = null; void cancelQuickAuth(currentGeneration).catch(() => {});
          reject(new Error('解锁响应超时，请重试'));
        }, 60_000);
        auth.current = { requestId, generation: currentGeneration, accountId, resolve, reject, timer };
        void requestQuickAuth({ ...input, requestId, generation: currentGeneration, accountId }).catch(error => {
          if (auth.current?.requestId !== requestId) return;
          auth.current = null; clearTimeout(timer);
          reject(new Error(typeof error === 'string' ? error : error instanceof Error ? error.message : '无法连接解锁服务，请重试'));
        });
      });
    }}
    onCancelAuthentication={cancelAuthentication}
    onChooseAccounts={() => {
      setNotice(null); setBusy(true);
      void askMain(state.current.query, ++state.current.seq, true).catch(() => { setBusy(false); setNotice('读取账户失败，请重试'); });
    }}
    onAuthenticationComplete={() => {
      setLocked(false); setNotice(null); setBusy(true);
      void askMain(state.current.query, ++state.current.seq).catch(() => { setBusy(false); setNotice('搜索失败，请重试'); });
    }}
    onOpenAccount={accountId => {
      if (state.current.pending) return;
      state.current.pending = true; setNotice(null); setBusy(true);
      const requestId = ++state.current.action;
      void askOpenAccount(accountId, requestId).catch(() => {
        if (requestId !== state.current.action) return;
        state.current.pending = false; setBusy(false); setNotice('无法打开账户，请重试');
      });
    }}
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
    onClose={() => { cancelAuthentication(); void invoke('quick_hide'); }} />;
}
