import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 移动端构建 —— **和桌面端共用一份源码、一份 HTML**。
 *
 * ## 为什么是「换一个 define」而不是「另起一个 app」
 *
 * 用户的判据是「PC 版窗口调窄，UI 自动跟着变……这个逻辑直接用到移动端上，
 * 它们就是从横屏调到竖屏的 PC 端」。也就是说**布局层不需要分家**：
 * 容器查询（`@container vault` / `@container shell`）在 390px 宽下已经把
 * rail 收成抽屉了，这件事在扩展预览里已经核过（见 docs 三·五）。
 *
 * 真正分家的只有**能力**，而能力差异由 `__PLATFORM__` 表达（编译期常量，
 * 见 packages/ui/src/platform.ts）。所以这里和 `vite.config.ts` 的差别只有：
 *
 * | | 桌面端 | 移动端 |
 * |---|---|---|
 * | `__PLATFORM__` | `'desktop'` | `'mobile'` |
 * | 入口 | `index.html` **和** `quick.html` | 只有 `index.html` |
 * | 产物 | `dist/` | `dist-mobile/` |
 *
 * ⚠️ **没有 `quick.html`**：快速面板是一个 `alwaysOnTop` / `skipTaskbar` 的
 * 常驻小窗（见 tauri.conf.json），移动端没有这个形态 —— 那边一个应用
 * 就是一块屏幕，不存在「另一个窗口」。
 *
 * ⚠️ **不要**在这里改 `viewport-fit` 之类的东西：HTML 是共用的一份，
 * 而 `viewport-fit=cover` 在桌面浏览器上会被忽略，所以两端共用是安全的。
 * 安全区那条约定由 `src/safe-area.test.ts` 守着 —— 它必须和
 * `styles.css` 里的 `env(safe-area-inset-*)` **成对**存在，少一个不报错。
 *
 * `build.target` 用 `safari15`：Tauri 2 的 iOS 最低版本是 13，但 2026 年
 * 还在跑的 iOS 设备基本都在 15 以上；写 13 只会让产物为了十几年前的
 * WebKit 降级语法。桌面端用的也是这一档。
 */
export default defineConfig({
  /*
   * 编译期平台常量 —— 打包时被替换成字面量，
   * 于是 `IS_DESKTOP && <AutotypeAction/>` 那一段**不进产物**。
   * 详见 packages/ui/src/platform.ts。
   */
  define: { __PLATFORM__: JSON.stringify('mobile') },
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    target: 'safari15',
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    rollupOptions: {
      // 单入口 —— 移动端没有第二个窗口（见上）
      input: { main: resolve(__dirname, 'index.html') },
    },
  },
});
