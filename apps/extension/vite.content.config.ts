import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * content script 单独构建。
 *
 * ⚠️ 必须是 IIFE 且**自包含**：Chrome 的 content script 不支持 ES module，
 * 出现任何 `import` 都会在加载时直接失败，而且失败是静默的 ——
 * 页面上什么都不会发生，控制台也不一定有声。
 *
 * 所以这个入口**不要 import 任何东西**，逻辑全部内联。
 */
export default defineConfig({
  root: 'src',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,   // 别把上一次构建的 popup 删掉
    target: 'chrome116',
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/content.ts'),
      name: 'CofferContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
