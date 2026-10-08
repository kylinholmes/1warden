import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 界面预览构建 —— **不打包进产品**。
 *
 * 用途：把界面组件用固定的假数据渲染成静态页面，好让截图工具（或人）
 * 在不启动 Tauri、不登录、**不需要任何 macOS 权限**的情况下看到真实排版。
 *
 * 这不是可有可无的开发便利。原生壳的界面验证依赖辅助功能/屏幕录制授权，
 * 而那两个授权在开发期每次重编都可能失效 —— 没有这条路，
 * 界面就只能靠「读代码想象」，而排版问题恰恰是读代码看不出来的
 * （本项目已经因为一个 Tailwind 命名空间冲突，把整个表单压成 12 像素宽）。
 */
/*
 * 这个预览是给**哪个平台**渲染的。
 *
 * ⚠️ 不是可有可无的开关：`__PLATFORM__` 是**编译期**常量，所以
 * 「移动端少一段 UI」这件事**只有换一个值重新构建才看得见**。
 * 用桌面端的预览在窄窗口下截图，看到的是桌面端在窄窗口下的样子 ——
 * 那不是移动端（顶栏让位、自动输入那一块、附件取回按钮都不一样）。
 *
 * 默认 desktop，保持既有的 `preview:build` / 文档里的命令不变。
 */
const PLATFORM = process.env['ONEWARDEN_PREVIEW_PLATFORM'] ?? 'desktop';

export default defineConfig({
  /*
   * 编译期平台常量 —— 共享组件靠它区分「这个构建是给谁的」。
   * 打包时被替换成字面量，另一端的分支直接不进产物。
   * 详见 packages/ui/src/platform.ts。
   */
  define: { __PLATFORM__: JSON.stringify(PLATFORM) },
  root: resolve(__dirname, 'preview'),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@1warden/vault': resolve(__dirname, '../../packages/vault/src/index.ts') } },
  build: {
    // 桌面端仍然是 `dist-preview`（文档和已有的截图命令都指着它）
    outDir: resolve(__dirname, PLATFORM === 'desktop' ? 'dist-preview' : `dist-preview-${PLATFORM}`),
    emptyOutDir: true,
    target: 'chrome116',
  },
});
