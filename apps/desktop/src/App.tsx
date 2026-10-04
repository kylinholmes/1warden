import { useMemo, useReducer, useCallback, Component, type ErrorInfo } from 'react';
import { VaultClient, type SessionStatus } from '@coffer/vault';
import { Connect } from './screens/Connect';
import { VaultView } from './screens/VaultView';
import { Unlock } from './screens/Unlock';
import { screenFor } from './screens/screen-for';
import { useQuickBridge } from './use-quick-bridge';
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
    onStatus: () => forceRender(),
  }), []);

  // 快速面板是另一个窗口，它向这里要数据、也由这里执行动作 ——
  // 主窗口是唯一持有会话的地方（见 quick-bridge.ts）
  useQuickBridge(client);

  const handleLock = useCallback(() => {
    client.lock();
    forceRender();
  }, [client]);

  const session = client.getSession();

  switch (screenFor(session.status)) {
    case 'vault':
      return <VaultView client={client} onLock={handleLock} />;
    case 'unlock':
      return (
        <Unlock
          client={client}
          onUnlocked={forceRender}
          onDisconnect={() => { client.logout(); forceRender(); }}
        />
      );
    default:
      return <Connect client={client} onConnected={forceRender} />;
  }
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
      <div className="flex h-full items-center justify-center overflow-y-auto p-8">
        <div className="w-full max-w-md">
          <h1 className="mb-1 text-[var(--text-lg)] font-semibold text-[var(--risk)]">界面出错了</h1>
          <p className="mb-5 text-[var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            这是 Coffer 的缺陷，不是你的操作问题。你的保险库数据没有受影响 ——
            它还在服务器上，重新打开即可。
          </p>

          {/* 技术细节给出来是为了能定位问题；不展示任何密钥或条目内容 */}
          <pre className="secret mb-5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-[var(--text-xs)] text-[var(--ink-secondary)]">
            {error.message || String(error)}
          </pre>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)]"
          >
            重新打开
          </button>
        </div>
      </div>
    );
  }
}
