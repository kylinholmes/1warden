import { partitionCiphers } from '@coffer/api';
import type { CipherDto, FolderDto, SyncResult as ApiSyncResult } from '@coffer/api';
import type { SymmetricKey } from '@coffer/crypto';
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
}

export interface SyncOutcome {
  skipped: boolean;
  itemCount: number;
  failedCount: number;
}

export class SyncEngine {
  private readonly deps: SyncDeps;
  private readonly session: VaultSession;
  private readonly onError: ((e: unknown) => void) | undefined;
  private lastRevision: number | null = null;
  private inFlight: Promise<SyncOutcome> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.deps = opts.deps;
    this.session = opts.session;
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
   * 把一份服务端载荷解密并写回会话。缓存与网络两条路共用。
   *
   * ⚠️ 抽出来是必须的：两份实现迟早会在「单条解不开怎么办」这类细节上分叉，
   * 而那种分叉的表现是「用缓存打开时少几条」—— 极难联想到。
   */
  private async apply(raw: ApiSyncResult, key: SymmetricKey): Promise<number> {
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

    // replaceData 内部会在非解锁态时忽略 —— 防止迟到的响应写回已锁定的会话
    this.session.replaceData(items, folders);
    return failedCount;
  }

  private async run(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    /*
     * ⚠️ 缓存**排在 revision 检查之前**。
     *
     * `getRevisionDate()` 本身是一次网络往返；排在它后面的话，
     * 「秒开」就还得先等一个请求回来 —— 那正是要省掉的东西。
     */
    const account = this.session.account;
    if (opts.force === true && this.deps.cache && account) {
      try {
        const cached = await this.deps.cache.load(account);
        if (cached) await this.apply(cached, opts.unlockedKey);
      } catch (e) {
        // 缓存坏了不该让同步失败 —— 下面还会去拉真的
        this.onError?.(e);
      }
    }

    const revision = await this.deps.getRevisionDate();
    if (opts.force !== true && this.lastRevision !== null && revision <= this.lastRevision) {
      return { skipped: true, itemCount: this.session.items.length, failedCount: 0 };
    }

    const raw = await this.deps.sync();
    const failedCount = await this.apply(raw, opts.unlockedKey);

    // 拿到新的才写缓存。写失败不影响本次同步 —— 只是下次还得全量拉
    try {
      if (account) await this.deps.cache?.save(account, raw);
    } catch (e) {
      this.onError?.(e);
    }

    // 只有成功才推进；失败时保持原值，下次仍会真的去同步
    this.lastRevision = revision;
    return { skipped: false, itemCount: this.session.items.length, failedCount };
  }
}
