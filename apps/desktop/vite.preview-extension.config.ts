import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The same PC preview and fixture, built with extension platform capabilities. */
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
