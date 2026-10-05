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
import { installHost } from '@coffer/ui';
import './preview.css';

/*
 * ⚠️ 预览也要装宿主，否则「记住的账户」在预览里恒为空。
 *
 * 账户存储走 `host().storage`；宿主没装时 `readAccounts()` 会抛、被那个
 * 函数吞掉、回 `[]`（对产品是对的：存储坏了不该挡住连接）—— 于是预览里
 * **永远停在「一个都没存」那一屏**，账户列表截不到，而症状只是
 * 「截图里少了几行」。
 *
 * ⚠️ `stub-chrome` 那份 `import` 必须排在最前面（见文件顶部的说明），
 * 但这块要排在它**后面** —— `ext-api` 是在模块求值时抓命名空间的。
 * 这里用 `localStorage` 而不是桩里的 chrome.storage：预览是静态页面，
 * localStorage 够用，而且它让 `?accounts=1` 能在渲染前把数据种进去。
 */
installHost({
  fetch: (...args) => fetch(...args),
  storage: {
    get: async (k) => localStorage.getItem(k),
    set: async (k, v) => localStorage.setItem(k, v),
    remove: async (k) => localStorage.removeItem(k),
  },
});

/*
 * `?accounts=1` 种几个记住的账户 —— 无头浏览器每次都是全新 profile，
 * 不种的话连接屏只截得到空白表单那一态。和桌面端预览同一个做法。
 */
if (new URLSearchParams(location.search).has('accounts')) {
  localStorage.setItem('coffer.accounts', JSON.stringify([
    { serverUrl: 'https://vault.example.com', email: 'me@example.com' },
    { serverUrl: 'https://vault.acme-corp.internal', email: 'zhang@acme.example' },
  ]));
}

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

/*
 * `?state=2fa`：填三个输入框并提交，好截图核对**两步验证**那一屏。
 *
 * ⚠️ 必须走**原型上的原生 setter**，不能直接赋 `el.value`。
 * React 的受控输入比对的是自己内部记的值：直接赋值它看不出变化、
 * 不重渲染，于是提交上去的仍然是空字符串 —— 表单会卡在 `required` 上，
 * 而**看起来就像是这一屏坏了**。
 *
 * 这一段缺席，正是这一屏一直没被肉眼核对过的原因（见 restructure-plan）。
 */
if (new URLSearchParams(location.search).get('state') === '2fa') {
  setTimeout(() => {
    const form = document.querySelector('form');
    const inputs = form?.querySelectorAll('input');
    if (!form || !inputs || inputs.length < 3) return;
    const setValue = (el: HTMLInputElement, v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(inputs[0] as HTMLInputElement, 'https://vault.example.com');
    setValue(inputs[1] as HTMLInputElement, 'me@example.com');
    setValue(inputs[2] as HTMLInputElement, 'correct horse battery staple');
    form.requestSubmit();
  }, 400);
}

/* \`?state=import\`：点开导入那一项，核对界面 */
if (new URLSearchParams(location.search).get('state') === 'import') {
  setTimeout(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === '导入')?.click(), 500);
}

/*
 * `?state=quick`：点第一个记住的账户，核对**快速解锁**那一屏
 * （账户摘要 + 只要主密码）。配合 `?accounts=1` 用。
 */
if (new URLSearchParams(location.search).get('state') === 'quick') {
  setTimeout(() => {
    /*
     * ⚠️ 按**文字**找，不能用 `querySelector('ul button')`。
     * 未登录时导航抽屉也会渲染（它自己有一套 `<ul><button>`），
     * 而它在 DOM 里排在前面 —— 选择器会点中那个，界面毫无变化，
     * 截图看起来只是「点了没反应」。
     */
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('me@example.com'))?.click();
  }, 500);
}

/* `?state=generator`：点开生成器那一项，核对和桌面端是不是同一份 */
if (new URLSearchParams(location.search).get('state') === 'generator') {
  setTimeout(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === '生成')?.click(), 500);
}

/*
 * `?state=import-preview` / `?state=import-done`：走**真实路径**喂一个假文件。
 *
 * ⚠️ 这两个状态之前一直缺，于是导入的**预览 / 结果**两段从来没被肉眼核对过
 * —— 而「跳过的行逐条说清楚」「失败的逐条列出」恰恰只在这两段里出现。
 * 修的东西和看过的东西没有交集，那不算验证过。
 *
 * 喂文件走的是 `input.files = DataTransfer.files` 再派发 `change`，
 * 和用户点选文件**同一条路** —— 不是绕过界面直接塞状态。
 */
{
  const which = new URLSearchParams(location.search).get('state');
  if (which === 'import-preview' || which === 'import-done') {
    // 先切到导入那一项 —— 这些状态验的是**那一屏的后续阶段**，不是列表
    setTimeout(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === '导入')?.click();
    }, 300);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('input[type=file]');
      if (!input) return;
      const dt = new DataTransfer();
      dt.items.add(new File(['name,url,username,password\n'], '1Password.1pux'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 结果那一段要再点一次「导入这 N 条」
      if (which === 'import-done') {
        setTimeout(() => {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('导入这'))?.click();
        }, 500);
      }
    }, 700);
  }
}

/*
 * `?state=new`：点列表头的「+」，核对**新建条目**那一屏
 * （和桌面端同一个 `ItemEditor`，在 440px 里以浮层形式盖住整屏）。
 */
if (new URLSearchParams(location.search).get('state') === 'new') {
  setTimeout(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="新建条目"]')?.click();
  }, 500);
}

/*
 * `?state=edit`：点开一条，再点 app bar 上的铅笔 —— 核对**编辑**那一屏。
 * 走真实点击路径（先详情、再编辑），验的才是真的。
 */
if (new URLSearchParams(location.search).get('state') === 'edit') {
  setTimeout(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('GitHub'))?.click();
  }, 400);
  setTimeout(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="编辑"]')?.click();
  }, 900);
}

/*
 * `?state=reveal`：点开一条，再点密码那一行的「显示」。
 * 揭示是**点击态**，所以要和 `detail` 分开截 —— 只看静态图验不到它。
 */
if (new URLSearchParams(location.search).get('state') === 'reveal') {
  setTimeout(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('GitHub'))?.click();
  }, 400);
  setTimeout(() => {
    /*
     * **把所有「显示」都点一遍** —— 密码和隐藏的自定义字段走的是**两条
     * 不同的消息**（`coffer:reveal` / `coffer:reveal-custom`），而两条桩
     * 回的值不同，所以一张截图就能分辨各自有没有走对。
     */
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[aria-label="显示"]')) {
      b.click();
    }
  }, 900);
}
