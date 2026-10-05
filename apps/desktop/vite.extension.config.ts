import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * **扩展目标**的 popup / background / offscreen 构建。
 *
 * ## 为什么它在 `apps/desktop` 里
 *
 * 这里曾经是 `apps/extension/vite.config.ts` —— 整个扩展是一个独立 app。
 * 那一版里，弹窗的界面和桌面端的界面是**两份各自演化的代码**，而它们本
 * 该是同一个东西：用户说的是「PC 版窗口调窄就是扩展」。
 *
 * 两份的代价不是「样式不一致」，是**同一个功能在两边行为不同**，而且不会
 * 有任何东西报错 —— 这个仓库里已经抓到 8 处（词表、缓存键、错误翻译……）。
 * 所以扩展不再是一个 app，它成了**同一个 app 的另一个构建目标**。
 *
 * | 目标 | 配置 | 入口 |
 * |---|---|---|
 * | 桌面 | `vite.config.ts` | `index.html` / `quick.html` |
 * | 扩展 | **本文件** | `extension/popup.html` / `background.ts` / `offscreen.html` |
 * | 注入脚本 | `vite.content.config.ts` | `extension/content.ts` / `webauthn-inject.ts` |
 * | 桌面预览 | `vite.preview.config.ts` | `preview/` |
 * | 扩展预览 | `vite.preview-extension.config.ts` | `preview-extension/` |
 *
 * ## ⚠️ 产物目录是 `dist-extension`，不是 `dist`
 *
 * `dist/` 是桌面端的（Tauri 指向它）。两个目标写同一个目录的话，
 * 先跑的那个会被后跑的 `emptyOutDir` 抹掉 —— 而症状是「扩展装上去少了
 * 一个文件」，看起来像 manifest 写错了。
 *
 * content script 单独一份配置（`vite.content.config.ts`）—— 它**不能**是
 * ES module，浏览器不接受 `import`，所以必须打成自包含的 IIFE。
 */
export default defineConfig({
  /*
   * 编译期平台常量 —— 共享组件靠它区分「这个构建是给谁的」。
   * 打包时被替换成字面量，另一端的分支直接不进产物。
   * 详见 packages/ui/src/platform.ts。
   */
  define: { __PLATFORM__: JSON.stringify('extension') },
  root: resolve(__dirname, 'extension'),
  publicDir: resolve(__dirname, 'extension/public'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist-extension'),
    emptyOutDir: true,
    // Chrome 116+（manifest 里声明的最低版本）
    target: 'chrome116',
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'extension/popup.html'),
        background: resolve(__dirname, 'extension/background.ts'),
        offscreen: resolve(__dirname, 'extension/offscreen.html'),
      },
      output: {
        // 固定的文件名：manifest.json 里写死了 background.js
        entryFileNames: '[name].js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
