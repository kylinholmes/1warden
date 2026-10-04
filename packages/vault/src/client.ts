/**
 * 把 @coffer/api 与 @coffer/vault 接起来的一层。
 *
 * 这一层是**唯一**知道「怎么从服务器地址+邮箱+主密码走到一个可用的保险库」的地方。
 * UI 只跟它打交道，不直接碰 HTTP 或密码学。
 *
 * ⚠️ 解出的明文与密钥只存在于这个模块的内存里，永不落盘（spec 不变量 S1）。
 */
import {
  HttpClient, prelogin, loginWithPassword, refreshToken, DEVICE_TYPE,
  type DeviceInfo, type TokenResponse,
} from '@coffer/api';
import {
  deriveMasterKey, hashMasterPassword, stretchMasterKey, decryptBytes,
  encryptString,
  KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID,
  type SymmetricKey, type KdfConfig,
} from '@coffer/crypto';
import { VaultSession, restoreSession } from './session';
import { SyncEngine } from './sync-engine';
import { decryptCipher, decryptFolder } from './decrypt';
import type { AccountInfo, SessionStatus, StoredSession } from './session';
import type { VaultFolder, VaultItem } from './model';
import type { ImportedItem } from './import';
import { emptyLogin, emptyCard, emptyIdentity } from './model';

/** 导入的类型名 → Bitwarden 的数字类型 */
const RAW_TYPE: Record<ImportedItem['type'], number> = {
  login: 1, secureNote: 2, card: 3, identity: 4,
};

/** 导入用的空白条目骨架 */
function blankImportItem(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: emptyLogin(),
    card: emptyCard(),
    identity: emptyIdentity(),
    secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

/**
 * 恢复一个已解锁的客户端所需要的**全部**状态。
 *
 * ⚠️ 传输层（`token`）也在里面，而且**必须**在。
 * 只恢复会话的话，读操作正常、写操作全部失败 —— 因为 baseUrl 与 token
 * 是客户端自己的状态，不在会话里。失败还报「连不上服务器」，
 * 让人往网络方向查，完全跑偏。
 */
export interface VaultClientState extends StoredSession {
  /** 访问令牌。null = 未曾登录过；`chrome.storage.session` 是内存存储，适合放它 */
  token: TokenResponse | null;
}

export interface ConnectParams {
  serverUrl: string;
  email: string;
  masterPassword: string;
}

/** 两步验证要求 —— UI 需要拿到候选方式让用户选 */
export interface TwoFactorChallenge {
  providers: number[];
  providersInfo: Record<string, unknown>;
}

export class VaultClient {
  private http: HttpClient;
  private session: VaultSession;
  private syncEngine: SyncEngine | null = null;
  private token: TokenResponse | null = null;
  private device: DeviceInfo;
  private masterKey: Uint8Array | null = null;
  private pendingConnect: ConnectParams | null = null;

  /** 传输层。桌面端注入走 Rust 的实现，扩展注入浏览器 fetch。 */
  private readonly fetchImpl: typeof fetch;
  private readonly deviceStore: DeviceIdStore;
  /** 设备标识要读存储，所以第一次用的时候才异步取 */
  private deviceId: Promise<string> | null = null;

  constructor(opts: {
    autoLockMs?: number;
    onLock?: () => void;
    onStatus?: (s: SessionStatus) => void;
    /**
     * 传输层。**必须由调用方注入** —— 没有通用默认值可用：
     *   - 桌面端：走 Rust 侧原生请求（WebView 的 fetch 会被 CORS 拦掉）
     *   - 浏览器扩展：直接 fetch（扩展有 host permission，不受 CORS 限制）
     *
     * 给一个「默认用全局 fetch」的兜底只会让桌面端在运行时才炸。
     */
    fetchImpl: typeof fetch;
    /** 设备标识的持久化。桌面端用 localStorage，扩展用 chrome.storage。 */
    deviceStore?: DeviceIdStore;
  }) {
    this.fetchImpl = opts.fetchImpl;
    this.deviceStore = opts.deviceStore ?? localStorageDeviceStore;
    this.device = {
      // 用桌面端的值而不是 CLI —— 服务端日志里能看出这是我们的应用
      type: DEVICE_TYPE.macOSDesktop,
      identifier: '',
      name: 'Coffer',
    };
    this.http = this.makeHttp('https://localhost');
    const sessionOpts: ConstructorParameters<typeof VaultSession>[0] = {};
    if (opts.autoLockMs !== undefined) sessionOpts.autoLockMs = opts.autoLockMs;
    if (opts.onLock) sessionOpts.onLock = opts.onLock;
    if (opts.onStatus) sessionOpts.onStatusChange = opts.onStatus;
    this.session = new VaultSession(sessionOpts);
  }

  getSession(): VaultSession { return this.session; }

  /** 设备标识只读一次，之后缓存 —— 它要落存储，不该每次请求都读一遍 */
  private deviceIdentity(): Promise<string> {
    this.deviceId ??= getDeviceIdentifier(this.deviceStore);
    return this.deviceId;
  }

  /**
   * 所有 HTTP 都从这里出去。
   *
   * ⚠️ **不要**在别处直接 `new HttpClient`：默认走的是 WebView 的 `fetch`，
   * 而页面的 origin 是 `tauri://localhost`，跨源请求会被 CORS 拦掉 ——
   * Vaultwarden 只对配置的 DOMAIN 回 ACAO，改不了。表现是「一直连不上服务器」，
   * 且与网络无关。详见 transport.ts 顶部的说明。
   */
  private makeHttp(baseUrl: string, headers?: () => Record<string, string>): HttpClient {
    return headers
      ? new HttpClient({ baseUrl, fetchImpl: this.fetchImpl, headers })
      : new HttpClient({ baseUrl, fetchImpl: this.fetchImpl });
  }

  /**
   * 连接并解锁。
   *
   * 若服务器要求两步验证，会抛出一个 `TwoFactorChallenge`（带 `__twoFactor` 标记），
   * 调用方应弹出输入框后调用 `connectWithTwoFactor`。
   */
  async connect(params: ConnectParams): Promise<void> {
    this.pendingConnect = params;
    const bare = this.makeHttp(params.serverUrl);

    const pl = await prelogin(bare, params.email);
    const kdf: KdfConfig = pl.kdf === KDF_TYPE_ARGON2ID
      ? {
        kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations,
        // 服务端没给就退回官方默认值 —— 缺字段不该让登录直接失败
        memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4,
      }
      : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations };

    const masterKey = await deriveMasterKey(params.masterPassword, params.email, kdf);
    const masterPasswordHash = await hashMasterPassword(masterKey, params.masterPassword);

    await this.finishConnect(bare, params, masterKey, masterPasswordHash, undefined);
  }

  async connectWithTwoFactor(code: string, provider: number, remember: boolean): Promise<void> {
    const params = this.pendingConnect;
    if (!params) throw new Error('没有待完成的两步验证流程');
    if (!this.masterKey) throw new Error('内部状态丢失，请重新开始登录');

    const bare = this.makeHttp(params.serverUrl);
    const hash = await hashMasterPassword(this.masterKey, params.masterPassword);
    await this.finishConnect(bare, params, this.masterKey, hash, { token: code, provider, remember });
  }

  private async finishConnect(
    bare: HttpClient, params: ConnectParams, masterKey: Uint8Array,
    masterPasswordHash: string,
    twoFactor: { token: string; provider: number; remember: boolean } | undefined,
  ): Promise<void> {
    const token = await loginWithPassword(bare, {
      email: params.email,
      masterPasswordHash,
      device: { ...this.device, identifier: await this.deviceIdentity() },
      ...(twoFactor ? { twoFactor } : {}),
    });

    if (!token.key) {
      throw new Error('服务器没有返回用户密钥（Key 字段缺失）—— 该账户可能没有完成密钥设置');
    }

    const stretched = await stretchMasterKey(masterKey);
    // ⚠️ 用户密钥是**原始 64 字节**，必须用 decryptBytes；
    // decryptString 会尝试 UTF-8 解码而失败
    const raw = await decryptBytes(token.key, stretched);
    if (raw.length !== 64) throw new Error(`用户密钥长度异常：${raw.length}（应为 64）`);
    const userKey: SymmetricKey = { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };

    this.masterKey = masterKey;
    this.token = token;
    this.http = this.makeHttp(params.serverUrl, this.authHeaders());

    // 从 JWT 的 sub 取用户 uuid —— 写入条目时 encryptedFor 需要它，
    // 而 api 层会自己填，我们只需要传给 createCipher
    const userId = jwtSub(token.accessToken);

    const account: AccountInfo = {
      serverUrl: params.serverUrl,
      email: params.email,
      userId,
      kdf: { kdf: 0, iterations: 0 } as KdfConfig,
    };
    this.session.setAccount(account);
    this.session.beginUnlock();

    await this.doSync(userKey);
    this.session.completeUnlock(userKey);
  }

  /**
   * 认证头。`connect` 与 `restore` **共用同一份** ——
   * 两处各写一遍的话，改了一处忘了另一处，恢复出来的客户端会缺头或少头，
   * 而表现只是「某些请求 401」，很难联想到是这里。
   */
  private authHeaders(): () => Record<string, string> {
    return () => ({
      Authorization: `Bearer ${this.token?.accessToken ?? ''}`,
      // 名称与版本号由 @coffer/api 的 HttpClient 默认带上（那里是唯一的来源），
      // 这里只补客户端特有的设备类型
      'Device-Type': String(this.device.type),
    });
  }

  /**
   * 导出「恢复这个客户端所需要的全部东西」。
   *
   * ⚠️ **恢复所需的状态必须只有一个来源。**
   *
   * 这个项目里已经因为「同一个事实有两个来源」栽过两次：客户端缓存了一份
   * 和会话重复的密钥（写操作全废）、恢复时机在模块加载时求值一次
   * （解锁早于恢复就永远恢复不了）。传输层是第三个 —— baseUrl 与 token
   * 存在客户端自己身上，恢复会话时不会跟着回来，于是所有需要网络的写操作
   * 都报「连不上服务器」。
   *
   * 让客户端自己说清楚它需要什么，而不是让调用方照着字段列表抄一遍。
   */
  exportState(): VaultClientState {
    const key = this.session.getKey();
    const account = this.session.account;
    if (!key || !account) throw new Error('保险库未解锁，没有可导出的状态');
    return {
      account,
      userKey: key,
      items: this.session.items.slice(),
      folders: this.session.folders.slice(),
      token: this.token,
    };
  }

  /**
   * 从 `exportState()` 的结果恢复 —— **进程重启后的路径**。
   *
   * ⚠️ 除了会话，还要把**传输层**一起接回去。少了这一步，读操作全都正常
   * （它们在内存里的数据上跑），而**写操作全部失败**，报的还是「连不上服务器」
   * 这种指向网络、让人去查 DNS 的错。
   */
  restore(state: VaultClientState): void {
    restoreSession(this.session, state);
    if (state.token === null) return;
    this.token = state.token;
    this.http = this.makeHttp(state.account.serverUrl, this.authHeaders());
  }

  /** 重新同步（用户手动刷新、或收到服务器变更通知时调用） */
  async refresh(): Promise<void> {
    const key = this.session.getKey();
    if (!key || !this.session.isUnlocked()) return;
    this.session.replaceData([], []); // 先清空，避免中间态被渲染成「全部消失了」
    await this.doSync(key);
  }

  private async doSync(unlockedKey: SymmetricKey): Promise<void> {
    this.syncEngine ??= new SyncEngine({
      session: this.session,
      deps: {
        getRevisionDate: () => getRevisionDateVia(this.http),
        sync: () => syncVia(this.http),
        decryptCipher,
        decryptFolder,
      },
      onError: (e) => console.warn('[sync] 一条记录解密失败，已跳过', e),
    });
    // 同步会把解密结果直接写进会话。`unlocking` 态也允许写入 ——
    // 首次解锁正是「先同步、后 completeUnlock」，数据必须在解锁完成前就位，
    // 否则解锁的那一瞬间会先渲染出一个空保险库。
    await this.syncEngine.sync({ unlockedKey, force: true });
  }

  getUserId(): string | null { return this.session.account?.userId ?? null; }

  // ── 文件夹 ──
  //
  // 文件夹名和条目名一样是**加密后**才发给服务端的 —— 服务端只存密文。
  // 这也是为什么这些方法必须在客户端而不是 api 层做加解密。

  /** 新建文件夹。重名是允许的 —— 服务端不拦，用户也可能是故意建两个。 */
  async createFolder(name: string): Promise<VaultFolder> {
    const key = this.requireKey();
    const dto = await createFolderApi(this.http, await encryptString(name, key));
    const folder = await decryptFolder(dto, key);
    this.session.replaceData(
      this.session.items.slice(),
      [...this.session.folders, folder],
    );
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const key = this.requireKey();
    await updateFolderApi(this.http, id, await encryptString(name, key));
    // 名字解出来才算数，所以重新同步一次而不是就地改 —— 免得本地显示
    // 一个服务端并不认的名字
    await this.refresh();
  }

  /**
   * 删除文件夹。
   *
   * ⚠️ **里面的条目不会消失** —— 服务端只删关联行，条目变成「无文件夹」。
   * 界面上的措辞必须与这个事实一致，不能吓唬用户说会删掉里面的密码。
   */
  async deleteFolder(id: string): Promise<void> {
    await deleteFolderApi(this.http, id);
    this.session.replaceData(
      // 同时把本地条目的 folderId 清掉，否则它们会挂在一个已经不存在的文件夹上，
      // 在「此文件夹」筛选里永远查不到
      this.session.items.map((i) => (i.folderId === id ? { ...i, folderId: null } : i)),
      this.session.folders.filter((f) => f.id !== id),
    );
  }

  // ── 写入 ──
  //
  // 策略：**先乐观更新本地，再触发同步**。
  // 直接等同步会让每次保存都卡住 UI 一两秒；而只改本地不同步则会让
  // 服务端与本地悄悄分叉。乐观更新 + 后台同步两头都占。

  /** 新建或更新一条。`item.id` 为空串表示新建。 */
  async saveItem(item: VaultItem): Promise<VaultItem> {
    const key = this.requireKey();
    const userId = this.requireUserId();
    const isNew = item.id === '';

    // 已有条目：带上服务端的 revisionDate 做乐观并发控制。
    // 不带的话，两端同时修改会静默覆盖 —— 服务端不会拦
    const opts: Parameters<typeof encryptCipher>[2] = isNew
      ? {}
      : { lastKnownRevisionDate: item.updatedAt };
    const body = await encryptCipher(item, key, opts);

    const dto = isNew
      ? await createCipher(this.http, userId, body)
      : await updateCipher(this.http, item.id, userId, body);

    const saved = await decryptCipher(dto, key);
    this.applyLocally(saved, isNew);
    return saved;
  }

  /** 软删除 —— 进回收站，**可恢复**。UI 上的「移到回收站」走这条。 */
  async moveToTrash(id: string): Promise<void> {
    await softDeleteCipher(this.http, id);
    this.removeLocally(id);
    void this.refresh().catch(() => { /* 后台同步失败不影响用户已经看到的删除 */ });
  }

  /**
   * 硬删除 —— **永久，不可恢复**。
   * UI 上必须先做二次确认，并且要明确告诉用户无法恢复。
   */
  async deletePermanently(id: string): Promise<void> {
    await hardDeleteCipher(this.http, id);
    this.removeLocally(id);
  }

  async toggleFavorite(id: string): Promise<void> {
    const item = this.session.items.find((i) => i.id === id);
    if (!item) return;
    // 收藏是局部更新 —— 不需要重新加密整条记录
    await updateCipherPartial(this.http, id, { favorite: !item.favorite });
    this.applyLocally({ ...item, favorite: !item.favorite }, false);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await setArchivedApi(this.http, id, archived);
    this.removeLocally(id);
    void this.refresh().catch(() => {});
  }

  /**
   * ⚠️ 密钥只有**一份**，在会话里。
   *
   * 早先客户端自己又缓存了一份 `userKey`，于是「已解锁」有了两个来源。
   * 后果是：恢复会话（进程重启）只灌了会话那一份，客户端那份还是 null ——
   * 读操作全部正常（它们走 session），**写操作全部报「保险库未解锁」**。
   * 这种「一半能用一半不能用」最难查，因为报错指向的方向是错的。
   */
  private requireKey(): SymmetricKey {
    const key = this.session.getKey();
    if (!key) throw new Error('保险库未解锁');
    return key;
  }

  private requireUserId(): string {
    const id = this.session.account?.userId;
    if (!id) throw new Error('没有已登录的账户');
    return id;
  }

  /** 局部更新会话里的条目列表 —— 不触发整库重解 */
  private applyLocally(item: VaultItem, isNew: boolean): void {
    if (!this.session.isUnlocked()) return;
    const current = this.session.items;
    const next = isNew
      ? [...current, item]
      : current.map((i) => (i.id === item.id ? item : i));
    this.session.replaceData(next, this.session.folders.slice());
  }

  private removeLocally(id: string): void {
    if (!this.session.isUnlocked()) return;
    this.session.replaceData(
      this.session.items.filter((i) => i.id !== id),
      this.session.folders.slice(),
    );
  }

  lock(): void {
    // 密钥由 `session.lock()` 负责 zeroize —— 这里不再单独清一份副本
    this.masterKey = null;
    this.session.lock();
  }

  logout(): void {
    this.masterKey = null;
    this.token = null;
    this.syncEngine = null;
    this.session.logout();
    void this.deviceStore.clear();
    this.deviceId = null;
  }

  // ── 导入 ──

  /**
   * 批量导入（目前来自 CSV）。
   *
   * ## 三条设计取向
   *
   * 1. **文件夹按名字复用**。同一份导出里几十条都在「工作」下 —— 建 47 个
   *    同名文件夹不是用户想要的。
   * 2. **单条失败不中断整批**。第 30 条因为某种原因写不进去，不该让后面
   *    170 条也进不来；失败的那几条要**逐条报出来**，而不是给一个总数。
   * 3. **有序写入**。并发几十个请求会把服务端和进度条都搞乱，
   *    而导入本来就是一次性的事，慢一点无妨。
   */
  async importItems(
    items: readonly ImportedItem[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ created: number; failed: { name: string; reason: string }[] }> {
    const key = this.requireKey();
    const userId = this.requireUserId();

    // 文件夹：已有的按名字复用，缺的建出来
    const folderIdByName = new Map(this.session.folders.map((f) => [f.name, f.id]));
    const wanted = [...new Set(items.map((i) => i.folderName).filter((n): n is string => n !== null))];
    for (const name of wanted) {
      if (folderIdByName.has(name)) continue;
      try {
        const created = await this.createFolder(name);
        folderIdByName.set(name, created.id);
      } catch {
        // 建文件夹失败不该让整批停下 —— 这些条目会变成「无文件夹」，
        // 内容还在，用户之后能自己归类
      }
    }

    let created = 0;
    const failed: { name: string; reason: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const src = items[i]!;
      try {
        const item: VaultItem = {
          ...blankImportItem(),
          name: src.name,
          type: src.type,
          rawType: RAW_TYPE[src.type],
          folderId: src.folderName === null ? null : folderIdByName.get(src.folderName) ?? null,
          favorite: src.favorite,
          notes: src.notes,
          notesFailed: false,
          login: src.login === null ? null : {
            username: src.login.username,
            password: src.login.password,
            totp: src.login.totp,
            // 有完整网址列表时以它为准（Bitwarden JSON / 1Password 导出能挂多个，
            // 且各带自己的匹配方式）；只有一列的 CSV 才退回 `uri`
            uris: src.login.uris
              ?? (src.login.uri === null ? [] : [{ uri: src.login.uri, match: null }]),
            passwordRevisionDate: null,
            // 导出的文件里没有 passkey —— 1Password 自己的导出也是静默丢弃的
            fido2Credentials: [],
          },
          // ⚠️ 卡片与身份必须一起搬。CSV 路径上它们是 null，
          // 但 Bitwarden 的 JSON 与 1Password 的导出里是完整存在的 ——
          // 丢掉的话用户会发现所有的卡都不见了，而导入报告说「全部成功」
          card: src.card ?? null,
          identity: src.identity ?? null,
          customFields: src.customFields.map((f) => ({
            name: f.name, value: f.value, type: f.type, linkedId: null,
          })),
        };
        const body = await encryptCipher(item, key, {});
        const dto = await createCipher(this.http, userId, body);
        // 直接解回来入会话，省掉一次整库同步
        const saved = await decryptCipher(dto, key);
        this.session.replaceData([...this.session.items, saved], this.session.folders.slice());
        created++;
      } catch (e) {
        failed.push({ name: src.name, reason: e instanceof Error ? e.message : '写入失败' });
      }
      onProgress?.(i + 1, items.length);
    }

    return { created, failed };
  }

  /** 手动锁定后重新解锁，不需要重新走完整登录 */
  async unlock(masterPassword: string): Promise<void> {
    const account = this.session.account;
    if (!account) throw new Error('没有已保存的账户');
    const bare = this.makeHttp(account.serverUrl);
    const pl = await prelogin(bare, account.email);
    const kdf: KdfConfig = pl.kdf === KDF_TYPE_ARGON2ID
      ? { kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
      : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations };

    const masterKey = await deriveMasterKey(masterPassword, account.email, kdf);
    const hash = await hashMasterPassword(masterKey, masterPassword);

    this.session.beginUnlock();
    await this.finishConnect(bare, {
      serverUrl: account.serverUrl, email: account.email, masterPassword,
    }, masterKey, hash, undefined);
  }

  isUnlocked(): boolean { return this.session.isUnlocked(); }
  getHttp(): HttpClient { return this.http; }
}

// ── 辅助 ──

function jwtSub(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('access token 不是合法 JWT');
  return (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub as string);
}

/**
 * 设备标识的持久化。
 *
 * 服务端靠它区分设备 —— 每次启动都换新的会在用户的设备列表里堆一堆。
 * 桌面端用 localStorage，扩展的 service worker 里没有 localStorage，
 * 得换成 chrome.storage。所以做成可注入的。
 */
export interface DeviceIdStore {
  get(): Promise<string | null> | string | null;
  set(id: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

const DEVICE_KEY = 'coffer.deviceId';

const localStorageDeviceStore: DeviceIdStore = {
  get: () => localStorage.getItem(DEVICE_KEY),
  set: (id) => localStorage.setItem(DEVICE_KEY, id),
  clear: () => localStorage.removeItem(DEVICE_KEY),
};

async function getDeviceIdentifier(store: DeviceIdStore): Promise<string> {
  const existing = await store.get();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await store.set(id);
  return id;
}

// 这些薄封装让依赖注入与调用点的签名保持简单
import {
  sync as apiSync, getRevisionDate as apiRevisionDate,
  createCipher, updateCipher, softDeleteCipher, hardDeleteCipher,
  setArchived as setArchivedApi, updateCipherPartial,
  createFolder as createFolderApi, updateFolder as updateFolderApi,
  deleteFolder as deleteFolderApi,
} from '@coffer/api';
// ⚠️ 这两个原来是 `from '@coffer/vault'` —— 那份文件曾经住在 apps/desktop，
// 搬到包里之后就成了自引用。tsc 能解析所以一直没报错，但它是错的。
import { encryptCipher } from './encrypt';

function syncVia(http: HttpClient) { return apiSync(http, ''); }
function getRevisionDateVia(http: HttpClient) { return apiRevisionDate(http, ''); }
