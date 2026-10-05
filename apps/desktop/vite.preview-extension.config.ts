import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 弹窗预览构建 —— **不打包进产品**。
 *
 * 把 `Popup` 用假的 `chrome.*` 渲染成静态页面，好在不装扩展、不登录、
 * 不需要任何浏览器扩展上下文的情况下截图核对排版。
 * 和 `vite.preview.config.ts`（桌面预览）是同一个思路。
 *
 * ⚠️ `@source` 必须显式声明 `../extension`：Tailwind 4 按**构建根目录**扫描
 * 类名，而这里的 root 是 `preview-extension/`，扫不到 `extension/` 里的组件，
 * 产出的 CSS 里就几乎没有工具类，界面变成一堆裸文本。
 * 见 preview-extension/preview.css。
 *
 * ⚠️ 根目录叫 `preview-extension/` 而不是塞进 `extension/` 里面：
 * `chrome-api-guard.test.ts` 会把整个 extension 目录扫一遍，而这里的
 * `stub-chrome.ts` **必须**伪造一个 `chrome` 全局 —— 放进去会被守卫正确地
 * 拦下来。它本来就该在守卫之外。
 *
 * ⚠️ 上面那句本来写的是扫描用的 glob 原文，里面带 `星号斜杠`，
 * 于是把这段块注释提前闭合了，构建报的是「Unexpected token」——
 * 一个指向错误方向的错。**块注释里不要写 glob**，同一件事这一轮犯了三次
 * （另外两次在 `vitest.config.ts` 和 `host-impl.ts`）。
 */
export default defineConfig({
  /*
   * 编译期平台常量 —— 共享组件靠它区分「这个构建是给谁的」。
   * 打包时被替换成字面量，另一端的分支直接不进产物。
   * 详见 packages/ui/src/platform.ts。
   */
  define: { __PLATFORM__: JSON.stringify('extension') },
  root: resolve(__dirname, 'preview-extension'),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist-preview-extension'),
    emptyOutDir: true,
    target: 'chrome116',
  },
});
