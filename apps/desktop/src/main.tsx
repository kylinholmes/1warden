import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from './App';
import { webAssemblyAvailable } from './capabilities';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    {/* 边界要在 StrictMode 内层：它兜的是 App 的渲染异常 */}
    {webAssemblyAvailable() ? (
      <ErrorBoundary>
        <App />
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
        <h1 className="mb-2 text-[var(--text-lg)] font-semibold text-[var(--risk)]">无法启动</h1>
        <p className="mb-3 text-[var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          Coffer 需要 WebAssembly 来处理主密码，而这台机器上的 WebView 不支持它
          （或是被安全策略禁用了）。
        </p>
        <p className="text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
          常见原因：系统版本过旧（需要 macOS 13 或更新），或应用包被修改过。
          请更新系统后重试。
        </p>
      </div>
    </div>
  );
}
