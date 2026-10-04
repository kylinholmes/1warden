import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * popup 与 background 的构建。
 *
 * content script 单独一份配置（vite.content.config.ts）—— 它**不能**是
 * ES module，浏览器不接受 `import`，所以必须打成自包含的 IIFE。
 */
export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Chrome 116+（manifest 里声明的最低版本）
    target: 'chrome116',
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
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
