/**
 * 扩展弹窗的预览 —— 用假的 `chrome.*` 把界面撑到有代表性的几种状态，
 * 供截图核对排版。
 *
 * 为什么需要它：弹窗跑在扩展上下文里，`chrome.tabs` / `chrome.runtime`
 * 在普通页面里不存在，直接打开 popup.html 只会停在「正在载入…」。
 * 没有这条路，弹窗的界面就只能靠读代码想象 ——
 * 而窄窄一条里，排版问题恰恰是读代码看不出来的。
 *
 * ⚠️ **`import './stub-chrome'` 必须排在 `import { Popup }` 之前。**
 * ES module 按书写顺序求值，而 `ext-api.ts` 是**在模块求值时**抓命名空间的。
 * 顺序反了的话桩等于没装，而症状是「正在载入…」—— 一个指向错误方向的症状。
 * 详细说明见 stub-chrome.ts 顶部。
 *
 * ⚠️ 这里的数据是**编造的**，只为把界面撑开。真实数据不进来。
 *
 * 构建：`bun run preview:build`（产物 `dist-preview/`，不打包进产品）
 */
import './stub-chrome';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from '../extension/popup/Popup';
import './preview.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);

/*
 * `?state=detail`：载入后**真的去点第一条**，好截图核对第三层。
 *
 * ⚠️ 不是直接渲染 `<ItemDetail>` —— 那样验的只是「这个组件单独长什么样」，
 * 验不到「点进去」这件事本身（导航、返回、列表还在不在）。
 * 走真实点击路径，验的才是真的。
 *
 * 弹窗自己的状态不该为截图开后门，所以这段留在 preview 里。
 */
if (new URLSearchParams(location.search).get('state') === 'detail') {
  setTimeout(() => {
    const row = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('GitHub'));
    row?.click();
  }, 400);
}

/*
 * `?state=copy`：真的走一遍复制。
 *
 * 先点 rail 上的「生成」，再点那个「复制」按钮 —— 用生成器那个而不是详情里
 * 的，因为它的反馈是**文字**（复制 → 已复制），截图里一目了然；
 * 详情里是图标版，勾和复制两个小图标在图上不好分辨。
 *
 * ⚠️ 这条验的是 `CopyButton` 的**异步取值**那条路：点击 → await getValue()
 * → 写剪贴板 → 反馈。类型检查验不到它，而它是「点了没反应」的高发区。
 */
if (new URLSearchParams(location.search).get('state') === 'copy') {
  const clickText = (t: string) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === t)?.click();
  setTimeout(() => clickText('生成'), 400);
  setTimeout(() => clickText('复制'), 800);
}

/* `?state=security`：点开安全报告那一项，好截图核对 */
if (new URLSearchParams(location.search).get('state') === 'security') {
  setTimeout(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.includes('安全报告'))?.click(), 500);
}

/* `?state=card`：点开那张卡片，核对卡片字段有没有铺出来 */
if (new URLSearchParams(location.search).get('state') === 'card') {
  setTimeout(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.includes('招商银行 Visa'))?.click(), 500);
}

/* \`?state=import\`：点开导入那一项，核对界面 */
if (new URLSearchParams(location.search).get('state') === 'import') {
  setTimeout(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === '导入')?.click(), 500);
}
