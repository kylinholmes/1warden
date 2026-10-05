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
  refreshAttachmentUrl, downloadAttachment, createAttachmentV2, uploadAttachmentBytes,
  type DeviceInfo, type TokenResponse,
} from '@coffer/api';
import {
  deriveMasterKey, hashMasterPassword, stretchMasterKey, decryptBytes,
  encryptString, makeUserKey,
  KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID,
  type SymmetricKey, type KdfConfig,
} from '@coffer/crypto';
import { VaultSession, restoreSession } from './session';
import { SyncEngine, type SyncCache, type UnlockCache } from './sync-engine';
import { decryptCipher, decryptFolder } from './decrypt';
import { unwrapAttachmentKey, decryptAttachmentContent } from './attachments';
import { encryptBytes } from '@coffer/crypto';
import type { AccountInfo, SessionStatus, StoredSession } from './session';
import type { VaultFolder, VaultItem } from './model';
import type { ImportedItem } from './import';
import { emptyLogin, emptyCard, emptyIdentity, emptySshKey } from './model';

/** 导入的类型名 → Bitwarden 的数字类型 */
const RAW_TYPE: Record<ImportedItem['type'], number> = {
  login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5,
};

/** 导入用的空白条目骨架 */
function blankImportItem(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: emptyLogin(),
    card: emptyCard(),
    identity: emptyIdentity(),
    secureNote: null, sshKey: null,
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
  private readonly syncCache: SyncCache | undefined;
  private readonly unlockCache: UnlockCache | undefined;
  private readonly onPhase: ((label: string, ms: number) => void) | undefined;
  private readonly onDisconnected: (() => void) | undefined;
  /** 连接起点。只给 `mark` 用 —— 诊断用，不参与任何逻辑 */
  private connectT0 = 0;

  /**
   * 报一次「从点登录到现在」的累计耗时。
   *
   * 报**累计**而不是分段：这条链路上各段的耗时差着量级（KDF 一秒、
   * 一次往返可能几百毫秒），累计值一眼能看出「时间堆在哪一段之前」，
   * 而分段值要自己在脑子里加。
   */
  private mark(label: string): void {
    this.onPhase?.(label, performance.now() - this.connectT0);
  }
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
    /**
     * 上次同步拿到的原始**密文**。
     *
     * 给不给只影响**快慢**，不影响功能 —— 不给就是每次全量拉。
     * ⚠️ 存的是密文不是明文，见 `SyncCache` 的说明（那条关系到 spec S1）。
     */
    syncCache?: SyncCache;
    /** 离线解锁用。不给就是每次都走网络（慢，但功能不变） */
    unlockCache?: UnlockCache;
    /** 同步开始/结束。与 `onStatus` 分开 —— 见 `VaultSession.syncing` */
    onSync?: (syncing: boolean) => void;
    /** 连接各阶段的耗时。只用于诊断「登录慢」这类问题，不参与任何逻辑 */
    onPhase?: (label: string, ms: number) => void;
    /**
     * 离线解锁之后，后台补登录**彻底失败**了。
     *
     * 界面此时是「已经解锁、数据是缓存那一版」，看起来完全正常 ——
     * 但客户端手上没有令牌，**所有写操作都会失败**。
     * 调用方该据此提示用户「当前离线」。
     */
    onDisconnected?: () => void;
  }) {
    this.fetchImpl = opts.fetchImpl;
    this.syncCache = opts.syncCache;
    this.unlockCache = opts.unlockCache;
    this.onPhase = opts.onPhase;
    this.onDisconnected = opts.onDisconnected;
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
    if (opts.onSync) sessionOpts.onSyncChange = opts.onSync;
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

    /*
     * ⚠️ 登录这一段**停在连接屏**，不另开加载屏。
     *
     * 试过把 `beginUnlock()` 提到这里、让整个验证过程都显示加载屏 ——
     * 方向是反的：连接屏的按钮本来就有忙碌态（转圈 +「验证中…」），
     * 足以说明「在做事」；再叠一整屏只会让**登录成功之后**也多停一屏，
     * 而那时候用户要的是立刻看到保险库。
     *
     * 计时留着：这条链路是三次网络往返加一次 KDF，每一段慢的处置都不同，
     * 不量就只能猜。
     */
    this.connectT0 = performance.now();

    const pl = await prelogin(bare, params.email);
    this.mark('prelogin（取 KDF 参数）');
    const kdf: KdfConfig = pl.kdf === KDF_TYPE_ARGON2ID
      ? {
        kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations,
        // 服务端没给就退回官方默认值 —— 缺字段不该让登录直接失败
        memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4,
      }
      : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations };

    const masterKey = await deriveMasterKey(params.masterPassword, params.email, kdf);
    this.mark('派生主密钥');
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

  /**
   * 登录，并把用户密钥解出来。**不碰会话状态** —— 什么时候翻到已解锁由调用方决定。
   *
   * 拆出来是因为现在有两条路都走到这里：正常登录，以及**本地解锁之后的补登录**
   * （那条路已经解锁过了，再翻一次状态会抛「只能在 unlocking 状态调用」）。
   */
  private async authenticate(
    bare: HttpClient, params: ConnectParams, masterKey: Uint8Array,
    masterPasswordHash: string,
    twoFactor: { token: string; provider: number; remember: boolean } | undefined,
  ): Promise<{ token: TokenResponse; userKey: SymmetricKey }> {
    const token = await loginWithPassword(bare, {
      email: params.email,
      masterPasswordHash,
      device: { ...this.device, identifier: await this.deviceIdentity() },
      ...(twoFactor ? { twoFactor } : {}),
    });

    if (!token.key) {
      throw new Error('服务器没有返回用户密钥（Key 字段缺失）—— 该账户可能没有完成密钥设置');
    }

    // ⚠️ 用户密钥是**原始 64 字节**，必须用 decryptBytes；
    // decryptString 会尝试 UTF-8 解码而失败
    const stretched = await stretchMasterKey(masterKey);
    const raw = await decryptBytes(token.key, stretched);
    if (raw.length !== 64) throw new Error(`用户密钥长度异常：${raw.length}（应为 64）`);
    return { token, userKey: { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) } };
  }

  /** 把令牌接到客户端上，并把账户写进会话。登录与补登录共用 */
  private adopt(bare: HttpClient, params: ConnectParams, masterKey: Uint8Array, token: TokenResponse): void {
    this.masterKey = masterKey;
    this.token = token;
    this.http = this.makeHttp(params.serverUrl, this.authHeaders());
    this.session.setAccount({
      serverUrl: params.serverUrl,
      email: params.email,
      userId: jwtSub(token.accessToken),
      kdf: { kdf: 0, iterations: 0 } as KdfConfig,
    });
  }

  private async finishConnect(
    bare: HttpClient, params: ConnectParams, masterKey: Uint8Array,
    masterPasswordHash: string,
    twoFactor: { token: string; provider: number; remember: boolean } | undefined,
  ): Promise<void> {
    const { token, userKey } = await this.authenticate(bare, params, masterKey, masterPasswordHash, twoFactor);
    this.mark('登录往返 + 解出用户密钥');
    this.adopt(bare, params, masterKey, token);
    this.session.beginUnlock();

    /*
     * ⚠️ **先解锁，再同步**（顺序反过一次，两边的理由都记着）。
     *
     * 原来的顺序是「先同步、后 completeUnlock」，理由是：同步没跑完就解锁的话，
     * 界面会先渲染出一个**空保险库**。那个理由仍然成立 —— 所以现在不是
     * 让用户看空的，而是：
     *
     *   ① 解锁 → 界面立刻可用，并显示「正在同步」
     *   ② 有本地缓存的话，**毫秒级**把上次的数据解出来填上
     *   ③ 再去服务端拉最新的，拉到了替换
     *
     * 慢的那一段是网络（`/api/sync` 一次返回整个库的密文），不是解密。
     */
    this.session.completeUnlock(userKey);

    // 存下「下次不用问服务端也能解锁」所需要的东西 —— 见 UnlockCache
    await this.saveUnlockCache(params, masterKey, token);

    this.mark('开始同步');
    await this.hydrateThenSync(userKey);
    this.mark('同步完成');
  }

  /**
   * 存下离线解锁要用的两样东西：**KDF 参数**和**被加密的用户密钥**。
   *
   * ⚠️ 存的是 `token.key`（**密文**），不是解出来的用户密钥。
   * 它由主密码派生出的密钥保护 —— 和服务端存的那一份是同一级别的保护，
   * 所以本地多一份副本不增加任何暴露。
   *
   * ⚠️ 绝不要把**解出来的**用户密钥写进来。那才是 S1 要拦的东西，
   * 而它看起来只是「省一次解密」。
   */
  private async saveUnlockCache(
    params: ConnectParams, masterKey: Uint8Array, token: TokenResponse,
  ): Promise<void> {
    if (!this.unlockCache || !token.key) return;
    try {
      /*
       * ⚠️ 存**派生参数**而不是主密钥。
       *
       * 这里要的是「下次解锁时不用再发 prelogin」——`kdf` 就是那个参数。
       * 存主密钥能省掉 KDF 那一秒，但那是**明文密钥落盘**，直接踩 S1。
       * 一秒 CPU 换一条不变量的完整，这个买卖没有犹豫的余地。
       */
      await this.unlockCache.save({
        serverUrl: params.serverUrl,
        email: params.email,
        kdf: await this.kdfOf(params),
        wrappedUserKey: token.key,
      });
    } catch (e) {
      console.warn('[解锁缓存] 写入失败', e);
    }
  }

  /** 问服务端这个账户的 KDF 参数。存缓存时用一次，代价可接受 */
  private async kdfOf(params: ConnectParams): Promise<KdfConfig> {
    const pl = await prelogin(this.makeHttp(params.serverUrl), params.email);
    return pl.kdf === KDF_TYPE_ARGON2ID
      ? { kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
      : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations };
  }

  /**
   * 后台同步：先吃缓存，再问服务端。**不阻塞调用方。**
   *
   * ⚠️ 这里吞掉异常是**故意**的：调用方已经拿到一个可用的、已解锁的客户端了，
   * 同步失败不该把它变成失败 —— 表现应当是「列表还停在缓存那一版」。
   * 错误由日志上报。
   */
  private async hydrateThenSync(key: SymmetricKey): Promise<void> {
    this.session.setSyncing(true);
    try {
      await this.doSync(key);
    } catch (e) {
      /*
       * ⚠️ 把 `e.message` 拼进**字符串**，不要只把 `e` 传进去。
       *
       * vite 转发页面 console 时只保留第一个参数的**第一行**，对象会被
       * 压成栈顶那一帧 —— 于是日志里只有 `requestRaw@…/http.ts:147`，
       * 而真正的原因（超时？401？证书？）一个字都看不到。
       */
      const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.warn(`[sync] 后台同步失败，界面停在已有数据上 —— ${why}`);
    } finally {
      this.session.setSyncing(false);
    }
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

  /**
   * 下载并解密一个附件。
   *
   * ## 两次失败要分开处理
   *
   * 1. **地址过期**：存下来的 `url` 由请求的 Host 头推导、每次 sync 重新生成。
   *    先要一个新的，失败再回退到存下来的那个（官方客户端也是这个顺序）。
   * 2. **密钥不对**：附件的密钥被用户密钥（或条目密钥）包装，
   *    用错的表现是解出来一堆乱码 —— 而文件确实下载到了。
   *
   * 带独立密钥的条目也支持 —— 包装后的密钥现在留在会话里（`wrappedKey`）。
   */
  async downloadAttachment(
    itemId: string, attachmentId: string,
  ): Promise<{ fileName: string; bytes: Uint8Array }> {
    const key = this.requireKey();
    const item = this.session.items.find((i) => i.id === itemId);
    if (!item) throw new Error('找不到这条条目');
    const attachment = item.attachments.find((a) => a.id === attachmentId);
    if (!attachment) throw new Error('这条条目上没有这个附件');
    // 附件密钥可能是被**条目密钥**包装的 —— 用和保存同一处的解析
    const wrappingKey = await this.keyFor(item);

    // 先要一个新的下载地址；拿不到就回退到存下来的那个
    let url = attachment.url;
    try {
      url = (await refreshAttachmentUrl(this.http, itemId, attachmentId)).url;
    } catch {
      // 存下来的地址可能还有效 —— 回退，而不是直接失败
    }

    const bytes = await downloadAttachment(this.http, url);
    const attKey = await unwrapAttachmentKey(attachment.key, wrappingKey);
    if (attKey === null) throw new Error('这个附件的密钥读不出来，无法解密');

    return { fileName: attachment.fileName, bytes: await decryptAttachmentContent(bytes, attKey) };
  }

  /**
   * 这条条目该用哪把密钥 —— 有独立密钥就解包出来，否则用用户密钥。
   *
   * ⚠️ **只有这一处**做这个判断。保存和取附件都要用同一把，
   * 两处各判断一次的话，改了一处忘了另一处，症状是「保存后条目打不开」
   * 或者「附件解出来是乱码」—— 都很难联想到是这里。
   */
  private async keyFor(item: VaultItem): Promise<SymmetricKey> {
    if (item.wrappedKey === null) return this.requireKey();

    const userKey = this.requireKey();
    // 条目密钥的包装方式与附件密钥一致：按**字节**加密的 64 字节
    let raw: Uint8Array;
    try {
      raw = await decryptBytes(item.wrappedKey, userKey);
    } catch {
      throw new Error('这条条目的独立密钥解不开，为避免写坏数据已中止');
    }
    if (raw.length !== 64) throw new Error('这条条目的独立密钥长度不对，为避免写坏数据已中止');
    return { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };
  }

  /**
   * 给一条条目加一个附件。
   *
   * ## 三步，顺序不能换
   *
   * 1. 生成一把**这条附件自己的** 64 字节密钥（不重用用户密钥 ——
   *    附件是唯一会被单独分享出去的东西）
   * 2. 用它加密文件内容
   * 3. 把**它自己**用条目密钥包装后，连同加密后的文件名一起登记到服务端
   *
   * ⚠️ 第 3 步的 `key` 是「包装后的附件密钥」，不是文件内容 ——
   * 两者都叫 key，混了的话上传会成功但谁也解不开。
   */
  async uploadAttachment(
    itemId: string, fileName: string, bytes: Uint8Array,
  ): Promise<{ attachmentId: string }> {
    const item = this.session.items.find((i) => i.id === itemId);
    if (!item) throw new Error('找不到这条条目');
    const wrappingKey = await this.keyFor(item);
    const userId = this.requireUserId();

    // 1 + 2：这条附件自己的密钥，用它加密内容
    const attachmentKey = makeUserKey();
    const encrypted = await encryptBytes(bytes, attachmentKey);

    const ticket = await createAttachmentV2(this.http, itemId, {
      // 包装后的附件密钥 —— 按**字节**包装，和用户密钥一样
      key: await encryptBytes(
        new Uint8Array([...attachmentKey.encKey, ...attachmentKey.macKey]), wrappingKey,
      ),
      fileName: await encryptString(fileName, wrappingKey),
      fileSize: encrypted.length,
    });

    /*
     * 3：把加密后的字节 POST 上去。
     *
     * ⚠️ **Vaultwarden 返回的是相对路径**（`/ciphers/{id}/attachment/{aid}`），
     * 而且不带 `/api` 前缀 —— 实测出来的。直接丢给 fetch 只有一句
     * "fetch() URL is invalid"，看不出是相对路径的问题。
     * 绝对地址（官方云端那种指向对象存储的）原样用。
     */
    /*
     * ⚠️ **这一步还没打通，所以明确报错，不做半通的事。**
     *
     * 登记那一步是好的 —— Vaultwarden 真的建了附件记录并返回了下载地址。
     * 但把字节送上去这一步走不通，实测：
     *
     *   - 它返回 `fileUploadType: 0` 和一个相对地址
     *     `/ciphers/{cid}/attachment/{aid}`
     *   - 那条地址在 `/api` 下是 404、在服务根下也是 404
     *     （用**存在**的条目试的，不是条目不存在导致的 404）
     *   - 老的 multipart 端点 `/api/ciphers/{cid}/attachment` 同样是 404
     *   - 唯一存在的是 `/api/ciphers/{cid}/attachment/v2`（无认证时回 401）
     *
     * 也就是说 Vaultwarden 只提供 v2 登记这一条路由，而它返回的上传地址
     * 指向一个它自己没提供的路径。下一件该做的事：翻 Vaultwarden 的源码
     * 确认 v2 之后字节到底该发到哪里（大概率是某个我没试到的动词或前缀），
     * 或者退回 multipart 并确认那条路由在当前版本里的真实形态。
     *
     * 宁可在这里停住，也不要发一个「上传成功但文件是坏的 / 根本没传上去」的版本。
     */
    throw new Error('附件上传暂时不可用（服务端上传地址对不上，见 client.ts 里的说明）');
    void ticket;
    // 服务端把附件挂到了条目上 —— 重新同步一次，本地才看得到它
    await this.refresh();
    void userId;
    return { attachmentId: ticket.attachmentId };
  }

  /** 重新同步（用户手动刷新、或收到服务器变更通知时调用） */
  async refresh(): Promise<void> {
    const key = this.session.getKey();
    if (!key || !this.session.isUnlocked()) return;
    this.session.replaceData([], []); // 先清空，避免中间态被渲染成「全部消失了」
    await this.doSync(key);
  }

  /** 建同步引擎。`doSync` 与本地解锁那条路共用 —— 两处各建一份必然长歪 */
  private makeSyncEngine(): SyncEngine {
    const engine = new SyncEngine({
      session: this.session,
      deps: {
        getRevisionDate: () => getRevisionDateVia(this.http),
        sync: () => syncVia(this.http),
        decryptCipher,
        decryptFolder,
      },
      onError: (e) => console.warn('[sync] 一条记录解密失败，已跳过', e),
    });
    engine.setCache(this.syncCache);
    return engine;
  }

  private async doSync(unlockedKey: SymmetricKey): Promise<void> {
    this.syncEngine ??= this.makeSyncEngine();
    // 同步会把解密结果直接写进会话。`unlocking` 态也允许写入 ——
    // 首次解锁正是「先同步、后 completeUnlock」，数据必须在解锁完成前就位。
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

    /*
     * ⚠️ **带独立密钥的条目必须用自己的密钥加密。**
     *
     * 服务端的 `key` 字段声明着「这条用独立密钥」，而字段本身若是用用户密钥
     * 加密的，任何客户端按声明去解都会失败 —— **条目就废了**。
     * 更糟的是它不会报错：保存成功、同步成功，用户下次打开才发现里面是空的。
     */
    const itemKey = await this.keyFor(item);
    const body = await encryptCipher(item, key, { ...opts, itemKey });

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
          sshKey: src.sshKey ?? null,
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
  /**
   * 解锁。
   *
   * ## 两条路，先试**本地的**那条
   *
   * 拿到用户密钥要走两次网络往返（prelogin 取 KDF 参数、login 取被加密的
   * 用户密钥）。实测用户的链路 7~70 秒一轮 —— 而这两次往返的结果
   * **几乎不变**，所以它们被缓存在本地（见 `UnlockCache`）。
   *
   *     输入主密码 → 用缓存的 KDF 参数派生（约 1.2s，纯 CPU）
   *               → 本地解出缓存的用户密钥 → 解锁 → 从密文缓存出数据
   *               → 后台补登录 + 同步
   *
   * 关键路径上**一次网络都不走**。这也顺带解决了一个体验问题：
   * 密码错了在本地就解得失败，不用等一轮网络才知道。
   *
   * ## 落回网络那条路的两种情况
   *
   * · 没有缓存（第一次在这台机器上解锁）
   * · 缓存的用户密钥解不开 —— 密码错了，**或者用户改过主密码**
   *   （服务端会重新包装用户密钥，本地那份就过期了）
   *
   * 第二种情况不该给出「密码错误」这种确定性的说法：两种原因在本地
   * 区分不了，所以说「本地记录对不上」，然后走网络去问个准的。
   */
  async unlock(masterPassword: string): Promise<void> {
    const account = this.session.account;
    if (!account) throw new Error('没有已保存的账户');

    const entry = await this.unlockCache?.load(account.serverUrl, account.email).catch(() => null);
    if (entry) {
      try {
        const masterKey = await deriveMasterKey(masterPassword, account.email, entry.kdf);
        const stretched = await stretchMasterKey(masterKey);
        const raw = await decryptBytes(entry.wrappedUserKey, stretched);
        if (raw.length !== 64) throw new Error(`用户密钥长度异常：${raw.length}`);
        const userKey: SymmetricKey = { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };

        this.masterKey = masterKey;
        this.session.beginUnlock();
        this.session.completeUnlock(userKey);
        console.warn('[解锁] 本地解锁成功 —— 关键路径上没有走网络');

        // 先把密文缓存解出来填上（纯本地），再去补登录和同步
        this.session.setSyncing(true);
        try {
          await this.doSyncFromCacheOnly(userKey);
        } finally {
          this.session.setSyncing(false);
        }
        void this.reloginAndSync(masterPassword, account);
        return;
      } catch (e) {
        console.warn('[解锁] 本地记录对不上，改走网络', e instanceof Error ? e.message : e);
      }
    }

    await this.unlockOnline(masterPassword, account);
  }

  /** 走网络那条路：原来那条，一次没变 */
  private async unlockOnline(masterPassword: string, account: AccountInfo): Promise<void> {
    const bare = this.makeHttp(account.serverUrl);
    const params: ConnectParams = {
      serverUrl: account.serverUrl, email: account.email, masterPassword,
    };
    const pl = await prelogin(bare, account.email);
    const kdf: KdfConfig = pl.kdf === KDF_TYPE_ARGON2ID
      ? { kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
      : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations };

    const masterKey = await deriveMasterKey(masterPassword, account.email, kdf);
    const hash = await hashMasterPassword(masterKey, masterPassword);

    this.session.beginUnlock();
    await this.finishConnect(bare, params, masterKey, hash, undefined);
  }

  /**
   * 本地解锁之后再补上网络那一半：登录拿令牌 → 接上传输层 → 同步。
   *
   * ⚠️ 用户已经在界面里了，这里**任何失败都不能冒出去** ——
   * 最坏的结果应当是「列表停在缓存那一版、左下角的圈一直转或者停掉」，
   * 而不是「保险库突然报错」。
   */
  private async reloginAndSync(masterPassword: string, account: AccountInfo): Promise<void> {
    this.session.setSyncing(true);
    try {
      const key = this.masterKey;
      if (!key) return;
      const hash = await hashMasterPassword(key, masterPassword);

      /*
       * ⚠️ **要重试。** 这一步不紧急，但不成功就没有令牌 ——
       * 而没有令牌时**所有写操作都会失败**，用户看到的是一句
       * 和网络有关的错，很难联想到「后台那半还没跑完」。
       *
       * 实测这条链路单次往返 5~10 秒且会断（`error decoding response body`
       * 是传输被截断）。一次抖动就永久放弃是不可接受的 ——
       * 那会把一个可用性问题变成「保存坏了」。
       *
       * 退避取 1s/2s/4s：链路本就要几秒一轮，退避太短只是把断掉的
       * 连接再撞一次。
       */
      const delays = [0, 1000, 2000, 4000];
      let last: unknown = null;
      for (const [i, wait] of delays.entries()) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const bare = this.makeHttp(account.serverUrl);
        try {
          const { token } = await this.authenticate(bare, {
            serverUrl: account.serverUrl, email: account.email, masterPassword,
          }, key, hash, undefined);
          this.adopt(bare, {
            serverUrl: account.serverUrl, email: account.email, masterPassword,
          }, key, token);
          await this.doSync(this.requireKey());
          console.warn(`[解锁] 后台补登录 + 同步完成（第 ${i + 1} 次尝试）`);
          return;
        } catch (e) {
          last = e;
          const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          console.warn(`[解锁] 后台补登录第 ${i + 1} 次失败 —— ${why}`);
        }
      }
      /*
       * 全部重试都用完。**这里必须让用户知道**：界面看起来一切正常，
       * 但保存会失败。只说「停在缓存那一版」是不够的 ——
       * 那听起来只是「数据旧了点」，而实际是「写不了」。
       */
      const why = last instanceof Error ? `${last.name}: ${last.message}` : String(last);
      console.warn(`[解锁] 后台补登录彻底失败，写操作会失败 —— ${why}`);
      this.onDisconnected?.();
    } finally {
      this.session.setSyncing(false);
    }
  }

  /** 只吃密文缓存，不碰网络。本地解锁那条路用它先把界面填上 */
  private async doSyncFromCacheOnly(key: SymmetricKey): Promise<void> {
    this.syncEngine ??= this.makeSyncEngine();
    await this.syncEngine.hydrateFromCache(key);
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
