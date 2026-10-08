import { installHost, type Host } from '@1warden/ui';
import { ext } from './ext-api';

/**
 * 扩展端的宿主实现 —— 见 `@1warden/ui/host` 的说明。
 *
 * 两处实现在这里，别处全是共享的：
 *
 * 1. **发请求直接 `fetch`**。扩展的 manifest 里声明了匹配所有 http(s)
 *    站点的 host permission，所以**不受 CORS 限制** —— 这正是桌面端做不到、
 *    必须把 HTTP 搬到 Rust 侧的那件事。扩展端绕那一圈没有意义。
 *
 * 2. **落盘存储用 `chrome.storage.local`** —— 扩展没有 `localStorage` 的
 *    稳定保证（弹窗和 service worker 是两个不同的上下文，而 SW 里根本
 *    没有 `localStorage`）。`ext.storage.local` 两端都能读。
 *
 * ⚠️ 这个文件**不能**被 service worker 之外的上下文当成普通模块引 ——
 * 不过它只做一次 `installHost`，重复调用会抛错，所以真出问题会立刻暴露，
 * 而不是悄悄用错实现。
 */
export function installExtensionHost(): void {
  const storage: Host['storage'] = {
    async get(key) {
      const got = await ext.storage.local.get(key);
      const v = got[key];
      return typeof v === 'string' ? v : null;
    },
    async set(key, value) {
      await ext.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await ext.storage.local.remove(key);
    },
  };

  installHost({
    /* 包一层而不是直接给 `fetch`：它依赖全局对象的 `this`，脱开调用会抛 Illegal invocation */
    fetch: (...args) => fetch(...args),
    storage,
  });
}
