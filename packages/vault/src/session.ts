import { zeroizeKey } from '@coffer/crypto';
import type { SymmetricKey, KdfConfig } from '@coffer/crypto';
import type { VaultItem, VaultFolder } from './model';

export type SessionStatus = 'loggedOut' | 'locked' | 'unlocking' | 'unlocked';

export interface AccountInfo {
  serverUrl: string;
  email: string;
  userId: string;
  kdf: KdfConfig;
}

export interface SessionEvents {
  onStatusChange?: (s: SessionStatus) => void;
  onLock?: () => void;
}

export interface SessionOptions extends SessionEvents {
  /**
   * 空闲多久后自动锁定。0 或省略 = 不自动锁定。
   * 外壳层应另外监听系统休眠/锁屏事件并直接调用 lock()。
   */
  autoLockMs?: number;
}

/**
 * 会话状态机。持有内存中的密钥与明文 —— 这两样东西**永不落盘**（spec 不变量 S1）。
 *
 *   loggedOut --setAccount--> locked --beginUnlock--> unlocking --completeUnlock--> unlocked
 *                                  ^                                                |
 *                                  +------------------- lock() ---------------------+
 */
export class VaultSession {
  private _status: SessionStatus = 'loggedOut';
  private _account: AccountInfo | null = null;
  private _key: SymmetricKey | null = null;
  private _items: VaultItem[] = [];
  private _folders: VaultFolder[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private readonly events: SessionEvents;
  private readonly autoLockMs: number;

  constructor(opts: SessionOptions = {}) {
    // 条件赋值而非直接搬 —— `exactOptionalPropertyTypes` 下
    // `{ onStatusChange: undefined }` 不能赋给 `{ onStatusChange?: ... }`
    this.events = {};
    if (opts.onStatusChange) this.events.onStatusChange = opts.onStatusChange;
    if (opts.onLock) this.events.onLock = opts.onLock;
    this.autoLockMs = opts.autoLockMs ?? 0;
  }

  get status(): SessionStatus { return this._status; }
  get account(): AccountInfo | null { return this._account; }
  get items(): readonly VaultItem[] { return this._items; }
  get folders(): readonly VaultFolder[] { return this._folders; }

  isUnlocked(): boolean { return this._status === 'unlocked'; }

  /**
   * 密钥。仅供本包内部与加密写入路径使用 —— **不要传给 UI 层**。
   * 跨进程边界（如 Tauri IPC）时绝不能序列化它。
   */
  getKey(): SymmetricKey | null { return this._key; }

  private setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.events.onStatusChange?.(s);
  }

  setAccount(account: AccountInfo): void {
    this._account = account;
    if (this._status === 'loggedOut') this.setStatus('locked');
  }

  beginUnlock(): void {
    if (this._status === 'loggedOut') throw new Error('尚未设置账户');
    if (this._status === 'unlocked') return;
    this.setStatus('unlocking');
    // 注意：这里**不**启动自动锁定计时器 —— 解锁过程本身可能很久（Argon2）
    this.clearTimer();
  }

  completeUnlock(key: SymmetricKey, items: VaultItem[], folders: VaultFolder[]): void {
    if (this._status !== 'unlocking') {
      throw new Error(`completeUnlock 只能在 unlocking 状态调用，当前是 ${this._status}`);
    }
    this._key = key;
    this._items = items;
    this._folders = folders;
    this.setStatus('unlocked');
    this.resetTimer();
  }

  /**
   * 刷新数据（同步完成时调用）。
   * ⚠️ 只在解锁态生效 —— 否则一个迟到的同步响应会把数据写回一个已经锁定的会话。
   */
  replaceData(items: VaultItem[], folders: VaultFolder[]): void {
    if (this._status !== 'unlocked') return;
    this._items = items;
    this._folders = folders;
  }

  /** 每次用户操作都应调用，用于重置空闲计时 */
  touchActivity(): void {
    if (this._status !== 'unlocked') return;
    this.resetTimer();
  }

  /**
   * 锁定并清空一切。
   *
   * ⚠️ **S5 不变量**：密钥缓冲区被**就地覆写**（`zeroizeKey`），
   * 条目与文件夹数组整体替换为空。
   *
   * 诚实的局限：JS 无法保证字符串被真正擦除 —— 明文密码作为 JS 字符串
   * 会在内存中留存到 GC 回收，且可能被复制。这里做到的是「不再可达」，
   * 不是「已擦除」。见 spec §5.4。
   */
  lock(): void {
    const wasUnlocked = this._status === 'unlocked';
    this.clearTimer();
    if (this._key) zeroizeKey(this._key);
    this._key = null;
    this._items = [];
    this._folders = [];

    if (this._status !== 'loggedOut') this.setStatus('locked');
    // 只在「确实从解锁态落锁」时触发，避免重复锁定反复通知 UI
    if (wasUnlocked) this.events.onLock?.();
  }

  /** 完全登出：连账户信息一起清掉 */
  logout(): void {
    this.lock();
    this._account = null;
    this.setStatus('loggedOut');
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.autoLockMs <= 0) return;
    this._timer = setTimeout(() => this.lock(), this.autoLockMs);
  }

  private clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
