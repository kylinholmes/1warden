/**
 * 把「这像个网页」的痕迹去掉。
 *
 * WebView 默认带着一整套浏览器行为，它们在浏览器里是对的、在原生应用里
 * 全都不对。已经处理掉的几件（另外几件在 CSS 里，见 styles.css 的
 * 「原生手感」那一段）：
 *
 * ## 右键菜单
 *
 * 不处理的话，右键会弹出「重新加载 / 检查元素 / 存储图像为…」——
 * 这是**最致命**的一条：它一眼就暴露「这是个网页」，而且「重新加载」
 * 按下去整个应用会重来一遍，用户的未保存状态直接没了。
 *
 * ⚠️ 但**输入框要放行**：那里用户期待的是系统那套「粘贴 / 全选」。
 * 一刀切掉的话，右键粘贴就没法用了 —— 那是真实的功能损失，
 * 不是少一个装饰。
 *
 * ## 拼写检查
 *
 * WKWebView 会给输入框划红波浪线，还带「替换为…」菜单。
 * 密码、网址、用户名全被当成英文单词划一遍红线。
 * 用 `spellcheck` 属性关掉，它**会被子元素继承**，所以在根元素上设一次即可
 * （在 index.html 上写着，那里更早生效，不会闪一下红线再消失）。
 *
 * ## 剩下的同类问题
 *
 * 这一类比 bug 难查，因为它们**不报错、不影响功能**，只是「感觉不对」。
 * 再遇到时按同一个思路问：浏览器这么做是因为它在浏览网页，而我们在做应用 ——
 * 那么这条行为在这个场景里还成立吗。
 */

/**
 * 顶上那条空白（系统标题栏让出来的 28px）也要能拖窗口。
 *
 * 红绿灯是系统画在窗口上的、不在 DOM 里，所以那块区域默认是「死」的 ——
 * 按在旁边拖不动，手感和系统窗口不一致。
 *
 * 这里**用 JS 建**而不是写进某个组件的 JSX：它是窗口级的外壳，
 * 不属于任何一个屏，而入口有三个（主窗口、快速面板、预览页）——
 * 写进 JSX 就得改三处，漏一处那个窗口的顶部就拖不动。
 */
function mountTitlebarStrip(): void {
  // 预览页里没有 Tauri 壳，建了也只是个挡不住东西的空 div，没必要
  if (!('__TAURI_INTERNALS__' in window)) return;
  if (document.documentElement.hasAttribute('data-quick-window')) return;
  if (document.documentElement.dataset['os'] !== 'mac') return;
  if (document.querySelector('.titlebar-strip') !== null) return;

  const strip = document.createElement('div');
  strip.className = 'titlebar-strip';
  strip.setAttribute('data-tauri-drag-region', 'deep');
  document.body.appendChild(strip);
}
export function initNativeFeel(): void {
  mountTitlebarStrip();
  document.addEventListener(
    'contextmenu',
    (e) => {
      const target = e.target as HTMLElement | null;
      // 可编辑的地方保留系统菜单（粘贴、全选都在那里）
      const editable = target?.closest('input, textarea, [contenteditable="true"]');
      if (editable != null) return;
      e.preventDefault();
    },
    // 捕获阶段：抢在别处可能加的监听之前把它拦掉
    { capture: true },
  );
}
