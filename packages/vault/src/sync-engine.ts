import { partitionCiphers } from '@coffer/api';
import type { CipherDto, FolderDto, SyncResult as ApiSyncResult } from '@coffer/api';
import type { SymmetricKey } from '@coffer/crypto';
import { decryptCipher, decryptFolder } from './decrypt';
import type { VaultSession } from './session';
import type { VaultItem, VaultFolder } from './model';

/**
 * 注入式依赖 —— 只注入**有 I/O 的**东西。
 * 纯函数（如 `partitionCiphers`）直接 import，不注入 ——
 * 注入一个纯函数只会增加仪式感，还会让测试跑在仿制品上而不是真实逻辑上。
 */
export interface SyncDeps {
  getRevisionDate(): Promise<number>;
  sync(): Promise<ApiSyncResult>;
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
   * 同步保险库。两重优化：
   *   1. **revision-date 短路** —— 服务端没变就完全不发请求（最大的性能杠杆）
   *   2. **并发去重** —— 同一时刻只跑一个，后来的复用前一个的 promise
   */
  sync(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    this.inFlight ??= this.run(opts).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    const revision = await this.deps.getRevisionDate();
    if (opts.force !== true && this.lastRevision !== null && revision <= this.lastRevision) {
      return { skipped: true, itemCount: this.session.items.length, failedCount: 0 };
    }

    const raw = await this.deps.sync();
    // ⚠️ 服务端不做过滤 —— 分区必须在这里做，否则已删除的密码会进列表
    const { active } = partitionCiphers(raw.ciphers ?? []);

    let failedCount = 0;
    const items: VaultItem[] = [];
    for (const dto of active) {
      try {
        items.push(await this.deps.decryptCipher(dto, opts.unlockedKey));
      } catch (e) {
        // ⚠️ 单条解不开不该让整个同步失败 —— 其余条目对用户仍有价值
        failedCount++;
        this.onError?.(e);
      }
    }

    const folders: VaultFolder[] = [];
    for (const dto of raw.folders ?? []) {
      try {
        folders.push(await this.deps.decryptFolder(dto, opts.unlockedKey));
      } catch (e) {
        failedCount++;
        this.onError?.(e);
      }
    }

    // replaceData 内部会在非解锁态时忽略 —— 防止迟到的响应写回已锁定的会话
    this.session.replaceData(items, folders);
    // 只有成功才推进；失败时保持原值，下次仍会真的去同步
    this.lastRevision = revision;
    return { skipped: false, itemCount: items.length, failedCount };
  }
}
