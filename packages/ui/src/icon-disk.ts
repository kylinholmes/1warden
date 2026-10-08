import type { IconDiskCache } from '@1warden/vault';

/**
 * 图标**落盘**缓存 —— 两端共用。
 *
 * ## 为什么这一份必须是共享的
 *
 * 它和平台无关（就是 IndexedDB），而**只有桌面端有**的时候，扩展端的表现是
 * 「每次打开弹窗都重新拉一遍图标」—— 服务端首次抓一个域名要 1.5 秒，
 * 而 `IconStore` 的内存缓存在弹窗关闭时就没了。桌面端早就解决了这件事，
 * 扩展端一直没有 —— 因为那份实现住在 `apps/desktop` 里，它够不着。
 *
 * ## 为什么是 IndexedDB，不是 localStorage
 *
 * ⚠️ 算过的，不是顺手：localStorage 每个源大约 5MB，而图标是一个域名一条、
 * data URL 约 40KB。**250 个域名就是 10MB** —— 会把整个 localStorage 撑爆，
 * 而它里面还住着同步缓存。撑爆的后果是**同步缓存也写不进去**，
 * 也就是「登录变慢」那个老问题会以一种完全无关的方式回来。
 */
const DB_NAME = 'onewarden-icons';
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
