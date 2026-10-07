import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from './App';
import { webAssemblyAvailable } from './capabilities';
import { initPlatform } from './platform';
import { installDesktopHost } from './host-impl';
import { initNativeFeel } from './native';
import { initTheme } from './theme';
import { IS_DESKTOP } from '@coffer/ui';
import { listen } from '@tauri-apps/api/event';
import { useQuickBridge } from './use-quick-bridge';
import { createDesktopApplication } from './application/desktop';
import './styles.css';

// 宿主要**最先**装：后面所有代码都可能用到它（发请求、读存储）
installDesktopHost();

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

// 主题和平台标记都得在**首次渲染之前**落上去，否则窗口会先按系统主题
// 画一帧再翻过来，左栏也会先按「没有红绿灯」排一次位置
initPlatform();
initNativeFeel();
initTheme();

const runtime = createDesktopApplication();

function DesktopEvents() {
  useQuickBridge(runtime.getActiveVault, runtime.subscribeActiveVault);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('coffer:tray-lock', () => { void runtime.client.lock(); }).then((off) => {
      if (disposed) off(); else unlisten = off;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return null;
}

createRoot(root).render(
  <StrictMode>
    {/* 边界要在 StrictMode 内层：它兜的是 App 的渲染异常 */}
    {webAssemblyAvailable() ? (
      <ErrorBoundary>
        {IS_DESKTOP && <DesktopEvents />}
        <App client={runtime.client} />
      </ErrorBoundary>
    ) : (
      <Unsupported />
    )}
  </StrictMode>,
);

/**
 * 密钥派生依赖 WebAssembly，用不了就等于整个应用不可用。
 * 这种情况必须在**用户填表单之前**就讲清楚，而不是等他点完「解锁」
 * 再甩一句英文的 CSP 报错。
 */
function Unsupported() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md">
        <h1 className="mb-2 text-lg font-semibold text-[var(--risk)]">无法启动</h1>
        <p className="mb-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
          1Warden 需要 WebAssembly 来处理主密码，而这台机器上的 WebView 不支持它
          （或是被安全策略禁用了）。
        </p>
        <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">
          常见原因：系统版本过旧（需要 macOS 13 或更新），或应用包被修改过。
          请更新系统后重试。
        </p>
      </div>
    </div>
  );
}
