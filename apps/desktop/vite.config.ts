import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri 需要固定端口且失败时不要自动换端口 —— 否则壳会连到一个不存在的地址
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  build: { target: 'safari15', sourcemap: true },
});
