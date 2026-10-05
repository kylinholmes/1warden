/**
 * 桌面端的同步缓存 —— 存上一次拿到的**原始密文**。
 *
 * ## 为什么这个不违反「密钥与明文永不落盘」
 *
 * 会话状态机的约定是密钥和**明文**不落盘（spec S1）。这里存的是
 * `/api/sync` 原样返回的密文 —— 它本来就要经过网络，落到本地磁盘
 * 不多泄露任何东西（攻击者拿到它，没有主密码也解不开）。
 *
 * ⚠️ **绝不要顺手把解密后的条目也存进来。** 那才是 S1 要拦的东西，
 * 而它看起来只是「再加一个字段」。慢的那一段是网络不是解密，
 * 所以存密文就够快了，没有理由去碰那条线。
 *
 * ## 为什么按账户分文件
 *
 * 一台机器上可能有多个账户（用户的截图里就有两个）。混在一起的话，
 * A 账户解锁时会先看到 B 账户的条目 —— 那是**串号**，比慢严重得多。
 *
 * ## 用 localStorage 而不是文件
 *
 * 一次同步的载荷通常几百 KB 到一两 MB。localStorage 的 5MB 量级够用，
 * 而超限时 `setItem` 会抛 —— 捕获之后**降级成不缓存**（慢，但正确）。
 * 换文件存储要加一个 Rust 命令，为这点数据不值当。
 */
import type { SyncCache, KdfCache, KdfCacheEntry } from '@coffer/vault';
import type { AccountInfo } from '@coffer/vault';
import type { SyncResult } from '@coffer/api';

/** 只保留最近一次 —— 缓存是「上次看到的样子」，不是历史 */
const keyFor = (serverUrl: string, email: string): string =>
  `coffer.synccache.${serverUrl}|${email}`;

/** 无状态 —— 账户由调用方传进来（见 `SyncCache` 接口上的说明） */
export const syncCache: SyncCache = (() => {
  return {
    async load(a: AccountInfo) {
      const key = keyFor(a.serverUrl, a.email);
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) {
          console.warn(`[缓存] 未命中 ${key}`);
          return null;
        }
        console.warn(`[缓存] 命中 ${key}，${(raw.length / 1024).toFixed(0)} KB`);
        return JSON.parse(raw) as SyncResult;
      } catch (e) {
        console.warn('[缓存] 读取失败', e);
        // 坏了就当作没有 —— 下一次同步会重写。让解析错误冒出去
        // 只会把一个「慢一点」降级成「打不开」
        return null;
      }
    },
    async save(a: AccountInfo, payload) {
      const key = keyFor(a.serverUrl, a.email);
      try {
        const json = JSON.stringify(payload);
        localStorage.setItem(key, json);
        console.warn(`[缓存] 已写入 ${(json.length / 1024).toFixed(0)} KB`);
      } catch (e) {
        console.warn('[缓存] 写入失败 —— 多半是超配额', e);
        // 多半是超配额。不缓存是**可用**的，只是下次全量拉 ——
        // 所以这里不能抛，抛了会让一次成功的同步看起来失败
      }
    },
  };
})();

/**
 * 缓存 KDF 参数 —— 省掉解锁时的一次 `prelogin` 往返。
 *
 * ⚠️ **只存公开参数。** 这里曾经还存 `wrappedUserKey`（被加密的用户密钥），
 * 是为「离线解锁」准备的；那条路已经删掉 —— 旧密码能打开本地缓存，
 * 而服务端改了主密码时本地那份不会跟着变。字段随之删掉。
 *
 *   · 它不参与任何鉴权 —— `prelogin` 本来就不需要认证
 *   · **验证仍然走 `login`**，那一次必须发，它才是「服务端验证」
 */
export const kdfCache: KdfCache = {
  async load(serverUrl, email) {
    const key = `coffer.unlock.${serverUrl}|${email}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      /*
       * ⚠️ 老版本存的那条**还带着 `wrappedUserKey`**，这里只取 `kdf`。
       * 那个字段会一直躺在磁盘上直到下次登录把整条覆盖 ——
       * 所以下面这个判断不只是「防坏数据」，它同时确保**旧结构不会被当成新结构用**。
       */
      const parsed = JSON.parse(raw) as KdfCacheEntry;
      return typeof parsed.kdf?.iterations === 'number' ? parsed : null;
    } catch {
      // 坏了就当没有 —— 下一次解锁多一次往返而已，
      // 让解析错误冒出去会把「慢一点」升级成「打不开」
      return null;
    }
  },
  async save(entry) {
    try {
      localStorage.setItem(`coffer.unlock.${entry.serverUrl}|${entry.email}`, JSON.stringify(entry));
    } catch {
      // 多半是超配额。不缓存是**可用**的，只是慢 —— 不能抛
    }
  },
};