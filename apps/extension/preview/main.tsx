/**
 * 扩展弹窗的预览 —— 用假的 `chrome.*` 把界面撑到有代表性的几种状态，
 * 供截图核对排版。
 *
 * 为什么需要它：弹窗跑在 Chrome 的扩展上下文里，`chrome.tabs` /
 * `chrome.runtime` 在普通页面里不存在，直接打开 popup.html 只会停在
 * 「正在载入…」。没有这条路，弹窗的界面就只能靠读代码想象 ——
 * 而 360px 宽的一条里，排版问题恰恰是读代码看不出来的
 * （这和桌面端 preview/ 存在的理由是同一个）。
 *
 * ⚠️ 这里的数据是**编造的**，只为把界面撑开。真实数据不进来。
 *
 * 构建：`bun run preview:build`（产物 `dist-preview/`，不打包进产品）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from '../src/popup/Popup';
import './preview.css';

const which = new URLSearchParams(location.search).get('state') ?? 'matched';

interface Row {
  id: string; name: string; username: string | null;
  hasPassword: boolean; hasTotp: boolean; uris: string[]; favorite: boolean;
}

const MATCHES: Row[] = [
  { id: '1', name: 'GitHub', username: 'me@example.com', hasPassword: true, hasTotp: true, uris: ['https://github.com'], favorite: true },
  { id: '2', name: '公司 GitHub 组织', username: 'zhang@acme.example', hasPassword: true, hasTotp: false, uris: ['https://github.com'], favorite: false },
];

/** 一切按 state 走 —— 弹窗只认消息，这里就把消息都接住 */
function stubChrome(): void {
  const unlocked = which !== 'locked';

  const reply = (msg: Record<string, unknown>): unknown => {
    switch (msg.type) {
      case 'coffer:status':
        return {
          unlocked,
          account: { email: 'me@example.com', serverUrl: 'https://vault.example.com' },
          itemCount: 42,
        };
      case 'coffer:matches':
        return { items: which === 'empty' ? [] : MATCHES };
      case 'coffer:pending':
        return which === 'pending'
          ? { pending: { url: 'https://github.com/session', username: 'me@example.com', action: 'save', itemId: null } }
          : { pending: null };
      default:
        return {};
    }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://github.com/login' }],
    },
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => reply(msg),
    },
  };
}

stubChrome();

// 锁定时背景里那个「连接」表单也要能看 —— ?state=connect 强制显示未登录。
// 未登录态由 status.unlocked=false 驱动，这里复用 locked 那条分支即可。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
