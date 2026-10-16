import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useCallback, useEffect, useRef, Component, type ErrorInfo } from 'react';
import type { ApplicationClient, ConnectionDraft } from './application/types';
import { Connect } from './screens/Connect';
import { VaultView } from './screens/VaultView';
import { Unlock } from './screens/Unlock';
import { screenFor } from './screens/screen-for';
import { IconAlert, IconSpinner } from '@1warden/ui';
import { ToastProvider } from './components/Toast';
import { AccountMetadataProvider } from './components/AccountMetadata';
import { ProfileAutosaveProvider, useProfileAutosave } from './components/ProfileAutosave';
import { Home } from './screens/Home';
import { Register } from './screens/Register';
import { accountKey, type AccountTarget } from './application/account-target';
import { createStore } from '@1warden/state';
import { UNSAVED_PROFILE_MESSAGE } from './profile-autosave';
import type { QuickAccountNavigation, SubscribeQuickAccountNavigation } from './quick-accounts';

/** One application tree; each entry supplies its own runtime. */
interface AppProps { client: ApplicationClient; subscribeQuickAccountNavigation?: SubscribeQuickAccountNavigation | undefined; openActiveAccount?: boolean | undefined }
export function App({ client, subscribeQuickAccountNavigation, openActiveAccount }: AppProps) {
  return <ProfileAutosaveProvider client={client}><AccountMetadataProvider client={client}><ToastProvider><AppContent client={client} subscribeQuickAccountNavigation={subscribeQuickAccountNavigation} openActiveAccount={openActiveAccount} /></ToastProvider></AccountMetadataProvider></ProfileAutosaveProvider>;
}
function AppContent({ client, subscribeQuickAccountNavigation, openActiveAccount }: AppProps) {
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const session = useStoreSnapshot(subscribe, getSnapshot, getSnapshot);
  const viewStore = useLocalStore(() => {
    const ready = false;
    const error = (null) as string | null;
    const attempt = 0;
    const route = ('home') as 'home' | 'work' | 'register';
    const entryDraft = undefined as ConnectionDraft | undefined;
    const navigating = false;
    return { ready, error, attempt, route, navigating, entryDraft };
  });
  const [ready, setReady] = useStoreField(viewStore, 'ready');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [attempt, setAttempt] = useStoreField(viewStore, 'attempt');
  const [route, setRoute] = useStoreField(viewStore, 'route');
  const [navigating, setNavigating] = useStoreField(viewStore, 'navigating');
  const [entryDraft, setEntryDraft] = useStoreField(viewStore, 'entryDraft');
  const navigation = useRef(false);
  const entryOperation = useRef(0);
  const entryWrites = useRef<Promise<void>>(Promise.resolve());
  const autosave = useProfileAutosave();
  const quickNavigation = useRef<QuickAccountNavigation>(async () => {});
  quickNavigation.current = async account => {
    if (navigation.current) throw new Error('正在切换账户，请稍后重试');
    await switchAccount(account);
  };
  useEffect(() => {
    if (!ready || !subscribeQuickAccountNavigation) return;
    return subscribeQuickAccountNavigation(account => quickNavigation.current(account));
  }, [ready, subscribeQuickAccountNavigation]);

  useEffect(() => {
    let alive = true;
    setReady(false);
    setError(null);
    void client.initialize().then(async () => {
      const draft = await client.connectionDraft?.load().catch(() => null);
      if (alive) {
        const current = client.getSnapshot();
        if (openActiveAccount && current.status === 'unlocked') { setEntryDraft(undefined); setRoute('work'); }
        else if (draft) { setEntryDraft(draft); setRoute(draft.intent === 'register' ? 'register' : 'work'); }
        else if (openActiveAccount && current.account) setRoute('work');
        setReady(true);
      }
    }).catch((e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : '无法载入保险库');
    });
    return () => { alive = false; entryOperation.current++; };
  }, [client, attempt, openActiveAccount]);

  const handleLock = useCallback(() => {
    void client.lock().catch((e: unknown) => setError(e instanceof Error ? e.message : '锁定失败'));
  }, [client]);
  const screen = screenFor(session.status);
  async function goHome() {
    if (navigation.current) return;
    entryOperation.current++;
    navigation.current = true; setNavigating(true); setError(null); setEntryDraft(undefined); setRoute('home');
    try {
      if (client.getSnapshot().status !== 'unlocked') await client.switchAccount(null);
      // A mode change may already be persisting its draft. Clear after that
      // write settles so an abandoned registration cannot resurrect its route.
      await entryWrites.current.catch(() => {});
      await client.connectionDraft?.clear();
      void autosave?.flush();
    } catch (e) { setError(e instanceof Error ? e.message : '返回首页失败'); }
    finally { navigation.current = false; setNavigating(false); }
  }
  async function switchAccount(account: AccountTarget | null, nextRoute: 'work' | 'register' = 'work') {
    if (navigation.current) return;
    entryOperation.current++;
    navigation.current = true; setError(null);
    try {
      const active = client.getSnapshot();
      if (!account || !active.account || accountKey(active.account) !== accountKey(account)) {
        await saveBeforeLeaving();
        setNavigating(true);
        await client.switchAccount(account);
      }
      setEntryDraft(undefined); setRoute(nextRoute);
    } catch (e) { setError(e instanceof Error ? e.message : '切换账户失败'); throw e; }
    finally { navigation.current = false; setNavigating(false); }
  }
  async function showRegistration(draft: ConnectionDraft) {
    const version = ++entryOperation.current;
    const registration = { ...draft, error: null, intent: 'register' as const };
    entryWrites.current = entryWrites.current.catch(() => {}).then(async () => {
      if (version === entryOperation.current) await client.connectionDraft?.save(registration);
    });
    await entryWrites.current;
    if (version !== entryOperation.current) return;
    setEntryDraft(registration); setError(null); setRoute('register');
  }
  async function showLogin(fields: Pick<ConnectionDraft, 'serverUrl' | 'email'>) {
    const version = ++entryOperation.current;
    const previous = await client.connectionDraft?.load();
    if (version !== entryOperation.current) return;
    const draft: ConnectionDraft = { ...fields, error: null,
      ...(previous?.returnAccount ? { returnAccount: previous.returnAccount } : {}) };
    entryWrites.current = entryWrites.current.catch(() => {}).then(async () => {
      if (version === entryOperation.current) await client.connectionDraft?.save(draft);
    });
    await entryWrites.current;
    if (version !== entryOperation.current) return;
    setEntryDraft(draft); setError(null); setRoute('work');
  }
  async function saveBeforeLeaving() {
    const result = await autosave?.flush();
    if (result && !result.saved) throw new Error(UNSAVED_PROFILE_MESSAGE);
  }
  async function logout() {
    if (navigation.current) return;
    entryOperation.current++;
    navigation.current = true; setError(null);
    try {
      const account = client.getSnapshot().account;
      await saveBeforeLeaving();
      setNavigating(true);
      await client.logout();
      if (account) autosave?.forget(accountKey(account)); setRoute('home');
    } catch (e) { setError(e instanceof Error ? e.message : '退出账户失败'); throw e; }
    finally { navigation.current = false; setNavigating(false); }
  }

  return (
    <>
      {!ready ? (
        <div className="flex h-full items-center justify-center bg-[var(--surface-canvas)] p-8">
          {error ? <div role="alert" className="text-sm text-[var(--risk)]">
            <p>{error}</p>
            <button className="btn btn-primary mt-4" onClick={() => setAttempt((n) => n + 1)}>重试</button>
          </div> : <p className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]"><IconSpinner size={16} />正在载入…</p>}
        </div>
      ) : <>
        {error && <div role="alert" className="fixed bottom-4 left-4 z-50 rounded-[var(--radius-sm)] bg-[var(--surface-overlay)] p-3 text-sm text-[var(--risk)]">{error}</div>}
        {route === 'home' ? <Home session={session} busy={navigating} onPick={account => { void switchAccount(account).catch(() => {}); }} onOther={() => { void switchAccount(null).catch(() => {}); }} onRegister={() => { void switchAccount(null, 'register').catch(() => {}); }} /> : navigating ? (
          // A switch immediately clears the session. Do not mount Connect during
          // that intermediate snapshot: its field effect would create a false draft.
          <div role="status" className="flex h-full items-center justify-center gap-2 bg-[var(--surface-canvas)] text-sm text-[var(--ink-secondary)]"><IconSpinner size={16} />正在切换账户…</div>
        ) : route === 'register' ? <Register client={client} initialDraft={entryDraft} onHome={goHome} onLogin={showLogin} /> : screen === 'vault' ? (
          <VaultView key={`${session.account?.serverUrl}:${session.account?.email}`} client={client} onLock={handleLock} onSwitchAccount={switchAccount} onLogout={logout} />
        ) : screen === 'unlock' ? (
          <Unlock client={client} onUnlocked={() => setError(null)} onDisconnect={() => { void goHome(); }} />
        ) : <Connect client={client} onConnected={() => setError(null)} onHome={goHome} initialCredentials={entryDraft} onRegister={showRegistration} />}
      </>}
    </>
  );
}

/**
 * 兜住渲染期抛出的异常。
 *
 * ⚠️ 没有它的话，React 会卸掉整棵树 —— 窗口还在，内容全空。用户看到的是
 * 「App 崩了」，而我们手上什么线索都没有。之前排查「点解锁就崩」时，
 * 这个空壳边界是最大的障碍：崩溃报告里干干净净，因为根本没崩，只是白屏。
 *
 * 必须写成 class —— React 没有提供 hook 形式的错误边界。
 */
export class ErrorBoundary extends Component<{ children: React.ReactNode }> {
  private readonly errors = createStore<{ error: Error | null }>(() => ({ error: null }));

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.errors.setState({ error });
    // Error boundaries require a class lifecycle; the fallback state still lives in Zustand.
    this.forceUpdate();
    // 控制台只在 devtools 可见（仅开发构建开启），这里主要留一份给现场排查
    console.error('[onewarden] 界面渲染出错：', error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.errors.getState();
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--surface-canvas)] p-8">
        <div className="screen-in w-full max-w-[420px]">
          <span className="mb-4 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-well)] text-[var(--risk)]">
            <IconAlert size={20} />
          </span>
          <h1 className="text-lg font-semibold">界面出错了</h1>
          <p className="mt-1.5 text-sm leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
            这是 1Warden 的缺陷，不是你的操作问题。你的保险库数据没有受影响 ——
            它还在服务器上，重新打开即可。
          </p>

          {/* 技术细节给出来是为了能定位问题；不展示任何密钥或条目内容 */}
          <pre className="secret my-5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-well)] p-3 text-xs text-[var(--ink-secondary)]">
            {error.message || String(error)}
          </pre>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-primary w-full py-2.5"
          >
            重新打开
          </button>
        </div>
      </div>
    );
  }
}
