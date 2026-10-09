import { partitionCiphers } from '@1warden/api';
import type { CipherDto, FolderDto, SyncResult as ApiSyncResult } from '@1warden/api';
import type { SymmetricKey, KdfConfig } from '@1warden/crypto';
import { decryptCipher, decryptFolder } from './decrypt';
import type { VaultSession, AccountInfo } from './session';
import type { VaultItem, VaultFolder } from './model';

/**
 * 注入式依赖 —— 只注入**有 I/O 的**东西。
 * 纯函数（如 `partitionCiphers`）直接 import，不注入 ——
 * 注入一个纯函数只会增加仪式感，还会让测试跑在仿制品上而不是真实逻辑上。
 */
/**
 * 上一次同步拿到的**原始密文**。
 *
 * ## ⚠️ 存的是密文，不是解密后的条目
 *
 * 会话状态机约定「密钥与明文永不落盘」（spec S1）。缓存**明文**会直接
 * 撞上那条不变量 —— 得做成显式例外（和指纹解锁同一类问题）。
 *
 * 但慢的那一段根本不是解密（258 条在本机是毫秒级），是**网络**：
 * `/api/sync` 一次性返回整个保险库的密文，往返一次可能就是几秒。
 *
 * 所以缓存**密文**就够快了 —— 解锁后立刻拿本地密文解出界面，
 * 再去后台问服务端有没有变。绕开了 S1，也拿到了速度。
 */
/**
 * 缓存 KDF 参数 —— **只是「迭代次数是多少」这个公开参数**。
 *
 * ## ⚠️ 这里曾经还存过 `wrappedUserKey`（被加密的用户密钥）
 *
 * 那是为「离线解锁」准备的：本地解出用户密钥，从而完全不碰网络。
 * 那条路已经删掉 —— 因为**旧密码能打开本地缓存**（服务端改了主密码，
 * 本地那份不会跟着变，而密码轮换恰恰是怀疑泄露时唯一的补救动作）。
 *
 * 删掉那条路之后，这个字段就**只剩写入、没有读者**了：一份躺在磁盘上的
 * 加密密钥副本，没有任何用途。留着它不会立刻出错，但它会：
 *   · 让读代码的人以为「本地能解出用户密钥」，而那件事已经不成立
 *   · 在有严格审计的场合，多一份没人解释得清的密钥副本
 *
 * 所以它被删掉了。**这里只留公开参数。**
 *
 * ## 为什么 KDF 参数可以缓存
 *
 * 它不参与任何鉴权 —— 服务端的 `prelogin` 本来就不需要认证。
 * 省掉它只是少一次往返，而**验证仍然走 `login`**，那一次必须发。
 */
export interface KdfCacheEntry {
  serverUrl: string;
  email: string;
  kdf: KdfConfig;
}

export interface KdfCache {
  load(serverUrl: string, email: string): Promise<KdfCacheEntry | null>;
  save(entry: KdfCacheEntry): Promise<void>;
}

export interface SyncCache {
  /*
   * ⚠️ 账户是**参数**，不是构造时捕获的。
   *
   * 客户端是在「还没登录」的时候构造的，那时根本不知道会是哪个账户；
   * 而缓存必须**按账户分开** —— 混在一起的话，A 账户解锁时会先看到
   * B 账户的条目，那是串号，比慢严重得多。
   *
   * 引擎在调用时手里有会话，账户是现成的。
   */
  load(account: AccountInfo): Promise<ApiSyncResult | null>;
  save(account: AccountInfo, payload: ApiSyncResult): Promise<void>;
}

export interface SyncDeps {
  getRevisionDate(): Promise<number>;
  sync(): Promise<ApiSyncResult>;
  /** 可选的本地缓存。不给就是每次全量拉 —— 功能不变，只是慢 */
  cache?: SyncCache;
  decryptCipher(dto: CipherDto, key: SymmetricKey): Promise<VaultItem>;
  decryptFolder(dto: FolderDto, key: SymmetricKey): Promise<VaultFolder>;
}

export interface SyncEngineOptions {
  deps: SyncDeps;
  session: VaultSession;
  onError?: (e: unknown) => void;
  /** A restored live session already owns fresher data, including a known empty vault. */
  hydrateCache?: boolean;
}

export interface SyncOutcome {
  skipped: boolean;
  itemCount: number;
  failedCount: number;
}

type SessionData = Pick<VaultSession, 'items' | 'folders'>;

export class SyncEngine {
  private readonly deps: SyncDeps;
  private readonly session: VaultSession;
  private readonly onError: ((e: unknown) => void) | undefined;
  private lastRevision: number | null = null;
  private inFlight: Promise<SyncOutcome> | null = null;
  private hydratedKey: SymmetricKey | null = null;

  constructor(opts: SyncEngineOptions) {
    this.deps = opts.deps;
    this.session = opts.session;
    if (opts.hydrateCache === false) this.hydratedKey = this.session.getKey();
    if (opts.onError) this.onError = opts.onError;
  }

  get lastSyncedAt(): number | null { return this.lastRevision; }

  /**
   * 装上本地缓存。
   *
   * 单独一个 setter 而不是构造参数：缓存由**客户端**持有（它是按账户
   * 分文件的），而引擎是在第一次同步时才惰性建出来的 —— 那时候客户端
   * 已经有缓存了，直接塞进来比让引擎反查客户端干净。
   */
  setCache(cache: SyncCache | undefined): void {
    if (cache) this.deps.cache = cache;
  }

  /**
   * 同步保险库。两重优化：
   *   1. **revision-date 短路** —— 服务端没变就完全不发请求（最大的性能杠杆）
   *   2. **并发去重** —— 同一时刻只跑一个，后来的复用前一个的 promise
   */
  sync(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    this.inFlight ??= this.run(opts).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * **只**吃本地密文缓存，不碰网络。
   *
   * 本地解锁那条路用它：用户密钥已经在手上了，而用户名下那份密文缓存
   * 也是本地的 —— 于是「打开就看到内容」完全不需要网络。
   *
   * 拿不到缓存时**什么都不做**（列表先空着），后面的网络同步会填上。
   */
  async hydrateFromCache(key: SymmetricKey): Promise<void> {
    const account = this.session.account;
    const sessionKey = this.session.getKey();
    if (!sessionKey || this.hydratedKey === sessionKey) return;
    this.hydratedKey = sessionKey;
    // Cached ciphertext is a first-paint fallback, not authoritative enough to
    // replace newer in-memory edits/restorations during an offline retry.
    const items = this.session.items;
    const folders = this.session.folders;
    if (items.length > 0 || folders.length > 0) return;
    if (!this.deps.cache || !account) return;
    try {
      const cached = await this.deps.cache.load(account);
      if (cached && this.session.items === items && this.session.folders === folders) await this.apply(cached, key, sessionKey);
    } catch (e) {
      this.onError?.(e);
    }
  }

  /**
   * 把一份服务端载荷解密并写回会话。缓存与网络两条路共用。
   *
   * ⚠️ 抽出来是必须的：两份实现迟早会在「单条解不开怎么办」这类细节上分叉，
   * 而那种分叉的表现是「用缓存打开时少几条」—— 极难联想到。
   */
  private currentSession(key: SymmetricKey | null): boolean {
    return key !== null && this.session.getKey() === key && this.session.isUnlocked();
  }

  private currentData(data: SessionData): boolean {
    return this.session.items === data.items && this.session.folders === data.folders;
  }

  private dataSnapshot(): SessionData {
    return { items: this.session.items, folders: this.session.folders };
  }

  private async apply(raw: ApiSyncResult, key: SymmetricKey, sessionKey: SymmetricKey | null,
    baseline: SessionData = this.dataSnapshot()): Promise<number | null> {
    if (!this.currentSession(sessionKey) || !this.currentData(baseline)) return null;
    // ⚠️ 服务端不做过滤 —— 分区必须在这里做，否则已删除的密码会进列表
    const { active } = partitionCiphers(raw.ciphers ?? []);

    let failedCount = 0;
    const items: VaultItem[] = [];
    for (const dto of active) {
      try {
        items.push(await this.deps.decryptCipher(dto, key));
      } catch (e) {
        // ⚠️ 单条解不开不该让整个同步失败 —— 其余条目对用户仍有价值
        failedCount++;
        this.onError?.(e);
      }
    }

    const folders: VaultFolder[] = [];
    for (const dto of raw.folders ?? []) {
      try {
        folders.push(await this.deps.decryptFolder(dto, key));
      } catch (e) {
        failedCount++;
        this.onError?.(e);
      }
    }

    // Status alone is insufficient: a new unlock can finish while old decryption is pending.
    // Both network and decryption can overlap a committed local edit. Never
    // replace that acknowledged write with this older server/cache snapshot.
    if (!this.currentSession(sessionKey) || !this.currentData(baseline)) return null;
    this.session.replaceData(items, folders);
    return failedCount;
  }

  private async run(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    const sessionKey = this.session.getKey();
    const skipped = (): SyncOutcome => ({ skipped: true, itemCount: this.session.items.length, failedCount: 0 });
    /*
     * ⚠️ 缓存**排在 revision 检查之前**。
     *
     * `getRevisionDate()` 本身是一次网络往返；排在它后面的话，
     * 「秒开」就还得先等一个请求回来 —— 那正是要省掉的东西。
     */
    // Each unlock may hydrate once. Subsequent retries must retain newer local
    // writes rather than reapplying the previous server snapshot from disk.
    const account = this.session.account;
    await this.hydrateFromCache(opts.unlockedKey);

    // A local write may finish while a response is in flight. Retry from a new
    // server snapshot rather than sharing the per-item write queue (restore and
    // archive already call refresh inside that queue). Bound sustained churn.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.currentSession(sessionKey)) return skipped();
      const baseline = this.dataSnapshot();
      const revision = await this.deps.getRevisionDate();
      if (!this.currentSession(sessionKey)) return skipped();
      if (!this.currentData(baseline)) continue;
      if (opts.force !== true && this.lastRevision !== null && revision <= this.lastRevision) {
        return skipped();
      }

      const raw = await this.deps.sync();
      const failedCount = await this.apply(raw, opts.unlockedKey, sessionKey, baseline);
      if (!this.currentSession(sessionKey)) return skipped();
      // Superseded responses cannot update either the ciphertext cache or the
      // revision marker: the next attempt must actually fetch fresh data.
      if (failedCount === null) continue;
      const committed = this.dataSnapshot();

      // 拿到新的才写缓存。写失败不影响本次同步 —— 只是下次还得全量拉
      try {
        if (account) await this.deps.cache?.save(account, raw);
      } catch (e) {
        this.onError?.(e);
      }

      // 只有成功才推进；失败时保持原值，下次仍会真的去同步
      if (!this.currentSession(sessionKey)) return skipped();
      if (!this.currentData(committed)) continue;
      this.lastRevision = revision;
      return { skipped: false, itemCount: this.session.items.length, failedCount };
    }
    throw new Error('同步期间记录持续变化，请稍后重试');
  }
}
