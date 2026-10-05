import { useMemo, useReducer, useCallback, useEffect, Component, type ErrorInfo } from 'react';
import { VaultClient, type SessionStatus } from '@coffer/vault';
import { syncCache } from './sync-cache';
import { Connect } from './screens/Connect';
import { VaultView } from './screens/VaultView';
import { Unlock } from './screens/Unlock';
import { screenFor } from './screens/screen-for';
import { IconAlert } from '@coffer/ui';
import { ToastProvider } from './components/Toast';
import { useQuickBridge } from './use-quick-bridge';
import { listen } from '@tauri-apps/api/event';
import { tauriFetch } from './transport';

export function App() {
  // 会话状态就是界面的状态。让 session 的变化驱动重渲染 ——
  // 而不是自己再维护一份 phase，那样两边的真相迟早会分叉。
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // 自动锁定：空闲 15 分钟。外壳层还应监听系统休眠/锁屏 —— 那是 Tauri 侧的事。
  const client = useMemo(() => new VaultClient({
    // 桌面端的所有 HTTP 都走 Rust 侧 —— WebView 的 fetch 会被 CORS 拦掉
    fetchImpl: tauriFetch,
    autoLockMs: 15 * 60 * 1000,
    onLock: () => forceRender(),
    // 同步开始/结束时也要重渲染 —— 界面上那个转圈靠它
    onStatus: () => forceRender(),
    onSync: () => forceRender(),
    /*
     * 连接各段的累计耗时。
     *
     * 打 `console.info` 而不是界面提示：这是**诊断**信息，用户看不懂也不需要看。
     * vite 会把 webview 的 console 转进 dev 日志，所以「登录慢」能直接读日志定位，
     * 不用靠猜。
     */
    onPhase: (label, ms) => { console.info(`[连接] ${label} — 累计 ${ms.toFixed(0)}ms`); },
    /*
     * 上次同步的密文缓存 —— 让「解锁后立刻看到条目」成为可能。
     *
     * ⚠️ 账户信息要等到**登录成功之后**才有，而这里是在构造时。
     * 所以给一个惰性的：真正 load/save 的时候账户已经就位了。
     */
    syncCache,
  }), []);

  // 快速面板是另一个窗口，它向这里要数据、也由这里执行动作 ——
  // 主窗口是唯一持有会话的地方（见 quick-bridge.ts）
  useQuickBridge(client);

  const handleLock = useCallback(() => {
    client.lock();
    forceRender();
  }, [client]);

  // 菜单栏的「锁定保险库」。
  //
  // ⚠️ 为什么要绕一圈由前端来做：密钥和明文都在 WebView 的内存里，
  // Rust 侧没有东西可清 —— 壳唯一能做的是告诉前端「用户要求锁定」。
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen('coffer:tray-lock', () => { handleLock(); }).then((u) => { un = u; });
    return () => un?.();
  }, [handleLock]);

  const session = client.getSession();
  const screen = screenFor(session.status);

  /*
    提示条的宿主包在**所有屏幕之外** —— 它是窗口级的东西，不属于任何一屏。
    保险库里的保存确认、解锁屏的报错、连接屏的报错，落在同一个右下角，
    换个屏幕不会换一套反馈。
  */
  return (
    <ToastProvider>
      {screen === 'vault' ? (
        <VaultView client={client} onLock={handleLock} />
      ) : screen === 'unlock' ? (
        <Unlock
          client={client}
          onUnlocked={forceRender}
          onDisconnect={() => { client.logout(); forceRender(); }}
        />
      ) : (
        <Connect client={client} onConnected={forceRender} />
      )}
    </ToastProvider>
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
interface BoundaryState { error: Error | null }

export class ErrorBoundary extends Component<{ children: React.ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台只在 devtools 可见（仅开发构建开启），这里主要留一份给现场排查
    console.error('[coffer] 界面渲染出错：', error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--surface-canvas)] p-8">
        <div className="screen-in w-full max-w-[420px]">
          <span className="mb-4 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-well)] text-[var(--risk)]">
            <IconAlert size={20} />
          </span>
          <h1 className="text-[var(--text-lg)] font-semibold">界面出错了</h1>
          <p className="mt-1.5 text-[var(--text-sm)] leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
            这是 Coffer 的缺陷，不是你的操作问题。你的保险库数据没有受影响 ——
            它还在服务器上，重新打开即可。
          </p>

          {/* 技术细节给出来是为了能定位问题；不展示任何密钥或条目内容 */}
          <pre className="secret my-5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-well)] p-3 text-[var(--text-xs)] text-[var(--ink-secondary)]">
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
