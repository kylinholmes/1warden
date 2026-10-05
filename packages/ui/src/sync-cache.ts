import { host } from './host';
import type { SyncCache, KdfCache, KdfCacheEntry, AccountInfo } from '@coffer/vault';

/*
 * ⚠️ `SyncResult` 从**接口本身**推，不从 `@coffer/api` 引 ——
 * 那会给 `packages/ui` 添一个它不需要的依赖，而这里要的只是
 * 「`SyncCache.load` 返回什么」。从接口推的话，那个类型将来搬家
 * （比如搬进 `@coffer/vault`）这个文件也不用跟着改。
 */
type SyncResult = NonNullable<Awaited<ReturnType<SyncCache['load']>>>;

/**
 * 同步缓存与 KDF 缓存 —— **两端共用这一份**。
 *
 * ## 为什么能共用
 *
 * 这两件事的逻辑和平台**无关**：把一段 JSON 按账户键存起来、读回来、
 * 坏了当没有。差异只在「存哪」那一个调用上 —— 而那已经由宿主吸收了
 * （`host().storage`，桌面端是 localStorage、扩展端是 chrome.storage.local）。
 *
 * 它们以前是两个 app 里各一份，逐行相同 —— 而这种「相同」是最危险的一种：
 * 改了一边忘另一边，不会有任何东西报错。
 *
 * ## ⚠️ 键里必须带账户
 *
 * `serverUrl|email`。混在一起的话，A 账户解锁时会先看到 B 账户的条目 ——
 * 那是**串号**，比慢严重得多。
 *
 * ## ⚠️ 存的是密文，不是密钥
 *
 * 同步缓存里是**服务端返回的原始密文**（本来就要过网络，落盘不多泄露
 * 任何东西）；KDF 缓存里是 `prelogin` 的**公开参数**（那个端点不需要认证）。
 *
 * 会话密钥走的是另一条路（`storage.session`，只在内存），两者放不同的区
 * 正是**因为敏感度不同**（spec 不变量 S1：明文与密钥永不落盘）。
 */

const syncKey = (a: AccountInfo): string => `synccache.${a.serverUrl}|${a.email}`;
const kdfKey = (serverUrl: string, email: string): string => `kdf.${serverUrl}|${email}`;

export const syncCache: SyncCache = {
  async load(account) {
    const key = syncKey(account);
    try {
      const raw = await host().storage.get(key);
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
  async save(account, payload) {
    try {
      const json = JSON.stringify(payload);
      await host().storage.set(syncKey(account), json);
      console.warn(`[缓存] 已写入 ${(json.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.warn('[缓存] 写入失败 —— 多半是超配额', e);
      // 不缓存是**可用**的，只是下次全量拉 —— 所以这里不能抛，
      // 抛了会让一次成功的同步看起来失败
    }
  },
};

/**
 * 缓存 KDF 参数 —— 省掉解锁时的一次 `prelogin` 往返。
 *
 * ⚠️ **不要在这里加 `wrappedUserKey` 之类的字段。** 曾经有过，是为
 * 「离线解锁」准备的，那条路已经删掉：旧密码能打开本地缓存，而服务端
 * 改主密码时本地那份不会跟着变 —— **而改主密码正是怀疑泄露时的补救措施**。
 * 主密码的验证必须走服务端。
 */
export const kdfCache: KdfCache = {
  async load(serverUrl, email) {
    try {
      const raw = await host().storage.get(kdfKey(serverUrl, email));
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as KdfCacheEntry;
      /*
       * ⚠️ 老版本存的那条**还带着 `wrappedUserKey`**，这里只取 `kdf`。
       * 那个字段会一直躺在磁盘上直到下次登录把整条覆盖 ——
       * 所以这个判断不只是「防坏数据」，它同时确保**旧结构不会被当成新结构用**。
       */
      return typeof parsed.kdf?.iterations === 'number' ? parsed : null;
    } catch {
      // 下一次解锁多一次往返而已，不该把「慢一点」升级成「打不开」
      return null;
    }
  },
  async save(entry) {
    try {
      await host().storage.set(kdfKey(entry.serverUrl, entry.email), JSON.stringify(entry));
    } catch {
      // 存不下只是下次多一次往返 —— 不能抛
    }
  },
};
