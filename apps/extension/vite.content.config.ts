import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * 注入到页面的脚本，单独构建。
 *
 * ⚠️ 必须是 IIFE 且**自包含**：Chrome 的 content script 不支持 ES module，
 * 出现任何 `import` 都会在加载时直接失败，而且失败是静默的 ——
 * 页面上什么都不会发生，控制台也不一定有声。
 *
 * 两个入口分两次构建（`COFFER_ENTRY` 选），而不是一次多入口：
 * Rollup 的 `iife` 格式**不支持代码分割**，多入口一旦产生共享 chunk 就直接报错，
 * 而「这两个入口恰好没有共享依赖」是个会随重构失效的隐式前提。
 *
 *   content  → 隔离世界，负责字段上报、提交检测、WebAuthn 转发
 *   webauthn → MAIN world，负责替换 navigator.credentials
 */
const WHICH = process.env['COFFER_ENTRY'] === 'webauthn'
  ? { entry: 'src/webauthn-inject.ts', name: 'CofferWebauthn', file: 'webauthn.js' }
  : { entry: 'src/content.ts', name: 'CofferContent', file: 'content.js' };

export default defineConfig({
  root: 'src',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,   // 别把上一次构建的其他产物删掉
    target: 'chrome116',
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, WHICH.entry),
      name: WHICH.name,
      formats: ['iife'],
      fileName: () => WHICH.file,
    },
  },
});
