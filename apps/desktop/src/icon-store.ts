/**
 * 把 `@coffer/vault` 的图标缓存接到桌面端的 HTTP 通路上。
 *
 * 图标的地址在**服务端**（`/icons/{域名}/icon.png`），而 WebView 的 origin
 * 是 `tauri://localhost`，跨源会被拦掉 —— 所以和其余请求一样走 Rust。
 * 详见 `transport.ts` 顶部。
 *
 * 这个接口**不需要认证**（实测：不带任何凭据也返回 200），所以这里不挂
 * 任何 token。服务端也因此无法把请求归到某个用户 —— 图标是实例级共享缓存。
 */
import { IconStore } from '@coffer/vault';
import { tauriFetch } from './transport';

/**
 * 按服务端地址缓存一个 store。
 *
 * 图标缓存要跨渲染、跨屏幕存活 —— 每次进列表都新建一个的话，
 * 缓存等于没有，每个域名都要重新请求一遍（服务端首次抓取要 1.5 秒）。
 * 换服务器时（地址变了）才重建。
 */
let cached: { serverUrl: string; store: IconStore } | null = null;

export function iconStoreFor(serverUrl: string): IconStore {
  if (cached !== null && cached.serverUrl === serverUrl) return cached.store;

  const store = new IconStore({
    serverUrl,
    fetchBytes: async (url) => {
      const res = await tauriFetch(url, { headers: { Accept: '*/*' } });
      // 图标取不到不是错误 —— 由 IconStore 回退到彩色徽标
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
  });

  cached = { serverUrl, store };
  return store;
}

/** 仅供测试：丢掉缓存，让下一个调用重建 */
export function resetIconStore(): void {
  cached = null;
}
