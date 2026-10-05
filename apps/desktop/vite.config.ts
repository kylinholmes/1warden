import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  /*
   * 编译期平台常量 —— 共享组件靠它区分「这个构建是给谁的」。
   * 打包时被替换成字面量，另一端的分支直接不进产物。
   * 详见 packages/ui/src/platform.ts。
   */
  define: { __PLATFORM__: JSON.stringify('desktop') },
  plugins: [react(), tailwindcss()],
  // Tauri 需要固定端口且失败时不要自动换端口 —— 否则壳会连到一个不存在的地址
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  build: {
    target: 'safari15',
    sourcemap: true,
    rollupOptions: {
      input: {
        // 主窗口
        main: resolve(__dirname, 'index.html'),
        // 快速面板是**独立窗口**，要有自己的 HTML 入口。
        // 两个入口共用同一份 React 与设计 token，但各自挂载不同的根组件。
        quick: resolve(__dirname, 'quick.html'),
      },
    },
  },
});
