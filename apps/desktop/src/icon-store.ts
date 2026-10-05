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
import { IconStore, type IconDiskCache } from '@coffer/vault';
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
    disk: indexedDbIconDisk,
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

/**
 * 图标存盘的实现 —— **IndexedDB，不是 localStorage**。
 *
 * ⚠️ 选 IndexedDB 是算过的，不是顺手：localStorage 每个源大约 5MB，
 * 而图标是一个域名一条、data URL 约 40KB。**250 个域名就是 10MB** ——
 * 会直接把整个 localStorage 撑爆，而它里面还住着同步缓存（409KB）。
 * 撑爆的后果是**同步缓存也写不进去**，也就是「登录变慢」那个老问题
 * 会以一种完全无关的方式回来。
 *
 * IndexedDB 没有这个量级的问题，而且接口本来就是异步的。
 */
const DB_NAME = 'coffer-icons';
const STORE = 'icons';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      // 用一个对象仓库、键就是域名 —— 不用索引，查询只有「按域名取」
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const indexedDbIconDisk: IconDiskCache = {
  async get(domain) {
    try {
      const db = await openDb();
      return await new Promise<string | null>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(domain);
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      // 打不开就当没有 —— 图标少一个是观感问题，不该让列表炸掉
      return null;
    }
  },
  async set(domain, dataUrl) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(dataUrl, domain);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* 写不进去只是下次重新拉 */ }
  },
};

/** 仅供测试：丢掉缓存，让下一个调用重建 */
export function resetIconStore(): void {
  cached = null;
}
