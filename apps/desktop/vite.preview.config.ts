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
export default defineConfig({
  root: resolve(__dirname, 'preview'),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@coffer/vault': resolve(__dirname, '../../packages/vault/src/index.ts') } },
  build: {
    outDir: resolve(__dirname, 'dist-preview'),
    emptyOutDir: true,
    target: 'chrome116',
  },
});
