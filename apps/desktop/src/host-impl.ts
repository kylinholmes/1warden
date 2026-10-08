import { installHost, type Host } from '@1warden/ui';
import { tauriFetch } from './transport';

/**
 * 桌面端的宿主实现 —— 见 `@1warden/ui/host` 的说明。和扩展端那份**对称**。
 *
 * 两处实现在这里，别处全是共享的：
 *
 * 1. **发请求走 Rust。** WebView 的 origin 是 `tauri://localhost`，
 *    和保险库服务器跨源 —— 直连会被 CORS 拦掉。`tauriFetch` 把请求交给
 *    Rust 侧发，顺带拿到了证书处理、超时和错误归类（`TransportError`）。
 *
 * 2. **落盘存储用 `localStorage`。** 桌面端只有一个 webview 上下文，
 *    localStorage 稳定可用；扩展端不行（弹窗和 service worker 是两个
 *    上下文，而 SW 里根本没有 localStorage）—— 这正是两边**必须**分开的那一处。
 *
 * ⚠️ `localStorage` 是**同步**的，而接口是异步的。这里不做任何包装：
 * 同步实现满足异步接口是天然成立的，多一层 `Promise.resolve` 只会让人
 * 以为它可能是异步的。桌面端的量级（几百 KB 的密文缓存）同步读没有可感延迟。
 */
export function installDesktopHost(): void {
  const storage: Host['storage'] = {
    async get(key) {
      return localStorage.getItem(key);
    },
    async set(key, value) {
      localStorage.setItem(key, value);
    },
    async remove(key) {
      localStorage.removeItem(key);
    },
  };

  installHost({
    /* `tauriFetch` 本来就是 `typeof fetch` —— 直接用，不做适配层 */
    fetch: tauriFetch,
    storage,
  });
}
