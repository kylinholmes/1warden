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
export type Os = 'mac' | 'win' | 'other';

export function detectOs(): Os {
  const ua = navigator.userAgent;
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
