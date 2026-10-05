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
import type { SyncCache } from '@coffer/vault';
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
