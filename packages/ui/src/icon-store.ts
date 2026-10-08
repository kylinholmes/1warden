import { IconStore } from '@1warden/vault';
import { host } from './host';
import { indexedDbIconDisk } from './icon-disk';

/**
 * 图标仓库 —— **两端共用**。
 *
 * 图标的地址在**服务端**（`/icons/{域名}/icon.png`），这个接口**不需要认证**
 * （实测：不带任何凭据也返回 200），所以这里不挂任何 token。服务端也因此
 * 无法把请求归到某个用户 —— 图标是实例级共享缓存。
 *
 * ⚠️ 取图标走**宿主**：桌面端的 WebView origin 是 `tauri://localhost`，
 * 跨源会被 CORS 拦掉、只能走 Rust；扩展端有 host permission，直接 fetch。
 * 两边只差这一个调用 —— 那正是宿主吸收掉的东西，所以这个文件里
 * **没有一行**平台相关的代码。
 *
 * ⚠️ 它曾经是两个 app 里的两份实现，而且**扩展端那份漏了 `disk`** ——
 * 表现是「每次打开弹窗都重新拉一遍图标」，而服务端首次抓一个域名要 1.5 秒。
 * 那种「两端各写一遍」的差异不会有人报错，只会让人觉得某端慢。
 */

/**
 * 按服务端地址缓存一个 store。
 *
 * 图标缓存要跨渲染、跨屏幕存活 —— 每次进列表都新建一个的话，缓存等于没有，
 * 每个域名都要重新请求一遍。换服务器时（地址变了）才重建。
 */
let cached: { serverUrl: string; store: IconStore } | null = null;

export function iconStoreFor(serverUrl: string): IconStore {
  if (cached !== null && cached.serverUrl === serverUrl) return cached.store;

  const store = new IconStore({
    serverUrl,
    disk: indexedDbIconDisk,
    fetchBytes: async (url) => {
      const res = await host().fetch(url, { headers: { Accept: '*/*' } });
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
