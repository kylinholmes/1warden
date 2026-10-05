/**
 * 扩展端的同步缓存 —— 存上一次拿到的**原始密文**。
 *
 * 和桌面端那份（`apps/desktop/src/sync-cache.ts`）是同一件事的两种接法，
 * 差别只在**存哪**：
 *
 *   桌面端  localStorage（webview 的持久化存储）
 *   扩展端  chrome.storage.local（扩展的持久化存储，约 10MB）
 *
 * 规则、键的构造、账户隔离全在 `@coffer/vault` 的 `SyncCache` 里，
 * 两边共用 —— 这里只负责「怎么存取」。
 *
 * ## ⚠️ 为什么不用 `chrome.storage.session`
 *
 * 扩展里那份**会话**（含用户密钥）放在 `session` 区，那是**内存**，
 * 浏览器一关就没了 —— 那是对的，密钥不该落盘（spec S1）。
 *
 * 而这份缓存里是**密文**：本来就要过网络，落盘不多泄露任何东西
 * （没有主密码解不开）。两者放不同的区，正是因为它们的**敏感度不同**，
 * 而不是随手挑的。
 */
import { host } from '@coffer/ui';
import type { SyncCache, KdfCache, KdfCacheEntry } from '@coffer/vault';
import type { AccountInfo } from '@coffer/vault';
import type { SyncResult } from '@coffer/api';

/**
 * ⚠️ 键里带 `serverUrl|email`。
 *
 * 混在一起的话，A 账户解锁时会先看到 B 账户的条目 —— 那是**串号**，
 * 比慢严重得多。桌面端同理。
 */
const keyFor = (a: AccountInfo): string => `synccache.${a.serverUrl}|${a.email}`;

export const extensionSyncCache: SyncCache = {
  async load(account) {
    const key = keyFor(account);
    try {
      const raw = await host().storage.get(key);
      return raw === null ? null : (JSON.parse(raw) as SyncResult);
    } catch {
      // 坏了就当没有 —— 下一次同步会重写。让解析错误冒出去
      // 只会把「慢一点」升级成「打不开」
      return null;
    }
  },
  async save(account, payload) {
    try {
      await host().storage.set(keyFor(account), JSON.stringify(payload));
    } catch {
      // 多半是超配额（10MB 量级）。不缓存是**可用**的，只是慢 —— 不能抛，
      // 抛了会让一次成功的同步看起来失败
    }
  },
};

/**
 * 缓存 KDF 参数 —— 省掉解锁时的一次 `prelogin` 往返。
 *
 * ⚠️ **扩展端一直没有这一份**，所以每次解锁都比桌面端多一次网络往返。
 * 而 `prelogin` 是**未认证**的公开端点（只要账户标识），缓存它不涉及
 * 任何秘密 —— 项目里曾经为「离线解锁」在本地存过 `wrappedUserKey`，
 * 那条路已经删掉（旧密码能打开本地缓存，而服务端改密码时本地不会跟着变）。
 * 这里只有公开参数，和那个被删掉的东西不是一回事。
 *
 * 走宿主存储：两端同一份逻辑，差异只在「存哪」那一个调用上。
 */
export const kdfCache: KdfCache = {
  async load(serverUrl, email) {
    try {
      const raw = await host().storage.get(`kdf.${serverUrl}|${email}`);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as KdfCacheEntry;
      // 形状不对就当没有 —— 下一次解锁多一次往返而已
      return typeof parsed.kdf?.iterations === 'number' ? parsed : null;
    } catch {
      return null;
    }
  },
  async save(entry) {
    try {
      await host().storage.set(
        `kdf.${entry.serverUrl}|${entry.email}`,
        JSON.stringify(entry),
      );
    } catch {
      // 存不下只是下次多一次往返 —— 不能抛，抛了会让一次成功的解锁看起来失败
    }
  },
};
