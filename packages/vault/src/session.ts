import { zeroizeKey } from '@1warden/crypto';
import type { SymmetricKey, KdfConfig } from '@1warden/crypto';
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
  /** 同步开始/结束。与状态变化**分开** —— 见 `syncing` 的说明 */
  onSyncChange?: (syncing: boolean) => void;
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

  /**
   * 正在后台同步。
   *
   * ⚠️ 这是**独立于 `status` 的一个维度**，不是第五种状态。
   *
   * 「已解锁」和「数据还在路上」可以同时成立 —— 界面该立刻可用（用户看得见
   * 应用、看得见自己在哪），只是列表还在往里填。把它并进状态机的话，
   * 要么退回到「同步完才解锁」（界面卡住，就是要修的那个问题），
   * 要么让「解锁」这个概念失去意义。
   */
  get syncing(): boolean { return this._syncing; }
  private _syncing = false;

  setSyncing(v: boolean): void {
    if (this._syncing === v) return;
    this._syncing = v;
    this.events.onSyncChange?.(v);
  }
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

  /**
   * 完成解锁：落下密钥，状态翻到 `unlocked`。
   *
   * ⚠️ **刻意不收 items/folders**。数据只有一条来路 —— 同步经 `replaceData` 写进来。
   *
   * 早先的签名是 `completeUnlock(key, items, folders)`，看起来可以「先解锁、
   * 数据待会再来」，于是解锁流程里写成 `completeUnlock(key, [], [])` 绕开
   * 「replaceData 只在解锁态生效」的限制，再在同步之后调用第二次 —— 第二次
   * 直接抛「只能在 unlocking 状态调用，当前是 unlocked」。用户看到的是
   * 登录成功、同步成功，最后一步却弹错。
   *
   * 去掉这两个参数之后，那个写法在类型上就不成立了。
   */
  completeUnlock(key: SymmetricKey): void {
    if (this._status !== 'unlocking') {
      throw new Error(`completeUnlock 只能在 unlocking 状态调用，当前是 ${this._status}`);
    }
    this._key = key;
    this.setStatus('unlocked');
    this.resetTimer();
  }

  /**
   * 刷新数据（同步完成时调用）。
   *
   * ⚠️ 只在 `unlocking` 与 `unlocked` 生效 —— 其余状态（`locked` / `loggedOut`）
   * 必须忽略，否则一个迟到的同步响应会把数据写回一个已经锁定的会话。
   *
   * `unlocking` 也要放行，是因为首次解锁的顺序就是
   * `beginUnlock → 同步写入 → completeUnlock(key)`：数据必须在解锁完成**之前**
   * 就位，否则解锁完成的瞬间会先渲染出一个空保险库。
   */
  replaceData(items: VaultItem[], folders: VaultFolder[]): void {
    if (this._status !== 'unlocked' && this._status !== 'unlocking') return;
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

/** 存储里的会话形态。`@1warden/vault` 不认识存储，这个类型只是恢复路径的入参。 */
export interface StoredSession {
  account: AccountInfo;
  userKey: SymmetricKey;
  items: VaultItem[];
  folders: VaultFolder[];
}

/**
 * 把一个已存的会话灌回会话对象 —— **进程重启后的恢复路径**。
 *
 * ## 为什么必须有
 *
 * service worker 约 30 秒空闲就被杀，模块变量全部归零。下次有消息时模块
 * 重新执行、`getClient()` 造出一个新客户端，它的会话是 `loggedOut` ——
 * 而 `chrome.storage.session` 里的密钥**还在**。
 *
 * 没有这条路径的话，表现是：用户明明刚解锁过，操作却报「保险库未解锁」；
 * 刷新一下好了、过一会儿又坏。这是最难查的一类问题，因为「存储里有」
 * 和「内存里有」是两件事，而报错只提后者。
 *
 * ⚠️ 数据要**拷贝**，不能直接把存储里那份引用进来 —— 共享数组会让一次写入
 * 同时改到「会话里看到的」和「下次要存回去的」，而且改坏了不会有人报错。
 *
 * ⚠️ 已经解锁时**直接返回**。唤醒时可能已经有别的消息先恢复了，
 * 再来一次会把用户已经看到的密钥和数据换掉。
 */
export function restoreSession(session: VaultSession, stored: StoredSession): void {
  if (session.getKey() !== null) return;

  // 顺序不能换：replaceData 只在 unlocking / unlocked 生效，
  // completeUnlock 又只能在 unlocking 调用
  session.setAccount(stored.account);
  session.beginUnlock();
  session.replaceData(stored.items.slice(), stored.folders.slice());
  session.completeUnlock(stored.userKey);
}
