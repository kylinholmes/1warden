import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 弹窗预览构建 —— **不打包进产品**。
 *
 * 把 `Popup` 用假的 `chrome.*` 渲染成静态页面，好在不装扩展、不登录、
 * 不需要任何浏览器扩展上下文的情况下截图核对排版。
 * 和桌面端的 `vite.preview.config.ts` 是同一个思路。
 *
 * ⚠️ `@source` 必须显式声明 `../src`：Tailwind 4 按**构建根目录**扫描类名，
 * 而这里的 root 是 `preview/`，扫不到 `src/` 里的组件，
 * 产出的 CSS 里就几乎没有工具类，界面变成一堆裸文本。
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'preview'),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist-preview'),
    emptyOutDir: true,
    target: 'chrome116',
  },
});
