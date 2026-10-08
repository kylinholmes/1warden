/**
 * 平台标记 —— 只有一个用途：自绘标题栏要不要给系统红绿灯让位。
 *
 * 写成独立模块而不是塞在某个入口里，是因为**有两个入口**：
 * `main.tsx`（主窗口）、`quick/main.tsx`（快速面板），预览页也算一个。
 * 上次主题就栽在这件事上：只在主入口初始化，另外两个入口各漏一次，
 * 而漏掉的表现都不是报错，是「某一个窗口长得跟别的不一样」。
 *
 * 用 UA 判断而不是引入 `@tauri-apps/plugin-os`：这里要的只是一个
 * 「左上角有没有那三个圆点」的布尔值。为它加一个原生插件、一条权限、
 * 一层异步（插件是异步的，而这件事必须在首次渲染之前就有答案）不划算。
 * UA 在 WKWebView 与 WebView2 里都稳定地带着系统名。
 */
export type Os = 'mac' | 'win' | 'ios' | 'android' | 'other';

/**
 * ⚠️ UA 是**参数**而不是直接读 `navigator` —— 因为这个判断必须能被测试。
 *
 * 它原来读全局，而它守着的那个 bug **在开发机上永远不复现**：
 * 桌面浏览器的 UA 里没有 "like Mac OS X"，只有 iPhone 的才有。
 * 于是类型检查、全部单测、构建全绿，而真机上顶部白白空掉 28px。
 * 详见 platform.test.ts。
 */
export function detectOs(ua: string = navigator.userAgent): Os {
  /*
   * ⚠️ 顺序是**语义的一部分**，不是风格问题。
   *
   * iPhone 的 UA 长这样：
   *
   *     Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 …
   *                        ^^^^^^^^^^^^^^^^
   *
   * 它**含有** "Mac OS X"。先判 Mac 就会把每一台 iPhone 都吃掉 ——
   * 而 `data-os='mac'` 意味着 `--titlebar-h: 28px`，那是给**三个红绿灯圆点**
   * 留的高度。iPhone 上没有那三个点，于是顶部白白空掉 28px。
   *
   * 所以：先认那些「UA 里混着别的系统名」的平台，再认桌面系统。
   */
  if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) return 'ios';
  if (ua.includes('Android')) return 'android';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'mac';
  if (ua.includes('Windows')) return 'win';
  return 'other';
}

/**
 * 写到根元素上，CSS 靠它选左边距（styles.css 的 --traffic-inset）。
 *
 * ⚠️ 必须在首次渲染之前调用：晚一帧的话，左栏会先按「没有红绿灯」
 * 排一次位置，然后跳一下。
 */
export function initPlatform(): void {
  document.documentElement.dataset['os'] = detectOs();
}

export function primaryShortcut(key: string, os: Os = detectOs()): string {
  return os === 'mac' || os === 'ios' ? `⌘${key}` : `Ctrl+${key}`;
}

export function quickShortcut(os: Os = detectOs()): string {
  return os === 'mac' ? '⌘⇧\\' : 'Ctrl+Shift+\\';
}
