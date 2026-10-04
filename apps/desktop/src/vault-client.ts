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
  KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID,
  type SymmetricKey, type KdfConfig,
} from '@coffer/crypto';
import { VaultSession, SyncEngine, decryptCipher, decryptFolder, type AccountInfo } from '@coffer/vault';

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
  private userKey: SymmetricKey | null = null;
  private masterKey: Uint8Array | null = null;
  private pendingConnect: ConnectParams | null = null;

  constructor(opts: { autoLockMs?: number; onLock?: () => void; onStatus?: (s: string) => void } = {}) {
    this.device = {
      // 用桌面端的值而不是 CLI —— 服务端日志里能看出这是我们的应用
      type: DEVICE_TYPE.macOSDesktop,
      identifier: getDeviceIdentifier(),
      name: 'Coffer',
    };
    this.http = new HttpClient({ baseUrl: 'https://localhost' });
    const sessionOpts: ConstructorParameters<typeof VaultSession>[0] = {};
    if (opts.autoLockMs !== undefined) sessionOpts.autoLockMs = opts.autoLockMs;
    if (opts.onLock) sessionOpts.onLock = opts.onLock;
    if (opts.onStatus) sessionOpts.onStatusChange = opts.onStatus as never;
    this.session = new VaultSession(sessionOpts);
  }

  getSession(): VaultSession { return this.session; }

  /**
   * 连接并解锁。
   *
   * 若服务器要求两步验证，会抛出一个 `TwoFactorChallenge`（带 `__twoFactor` 标记），
   * 调用方应弹出输入框后调用 `connectWithTwoFactor`。
   */
  async connect(params: ConnectParams): Promise<void> {
    this.pendingConnect = params;
    const bare = new HttpClient({ baseUrl: params.serverUrl });

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

    const bare = new HttpClient({ baseUrl: params.serverUrl });
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
      device: this.device,
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
    this.userKey = userKey;
    this.token = token;
    this.http = new HttpClient({
      baseUrl: params.serverUrl,
      headers: () => ({
        Authorization: `Bearer ${this.token?.accessToken ?? ''}`,
        'Device-Type': String(this.device.type),
        'Bitwarden-Client-Name': 'desktop',
        // 发一个较新的版本号：服务端在版本过旧时会过滤掉 SSH key 类条目
        'Bitwarden-Client-Version': '2026.10.0',
      }),
    });

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
    this.session.completeUnlock(userKey, this.session.items.slice(), this.session.folders.slice());
  }

  /** 重新同步（用户手动刷新、或收到服务器变更通知时调用） */
  async refresh(): Promise<void> {
    const key = this.userKey;
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
    // 第一次同步前先解锁，否则 replaceData 会被忽略
    if (!this.session.isUnlocked()) {
      this.session.completeUnlock(unlockedKey, [], []);
    }
    await this.syncEngine.sync({ unlockedKey, force: true });
  }

  getUserId(): string | null { return this.session.account?.userId ?? null; }

  lock(): void {
    this.userKey = null;
    this.masterKey = null;
    this.session.lock();
  }

  logout(): void {
    this.userKey = null;
    this.masterKey = null;
    this.token = null;
    this.syncEngine = null;
    this.session.logout();
    clearDeviceIdentifier();
  }

  /** 手动锁定后重新解锁，不需要重新走完整登录 */
  async unlock(masterPassword: string): Promise<void> {
    const account = this.session.account;
    if (!account) throw new Error('没有已保存的账户');
    const bare = new HttpClient({ baseUrl: account.serverUrl });
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

/** 设备标识持久化 —— 服务端靠它区分设备，每次启动都换新的会在设备列表里堆一堆 */
const DEVICE_KEY = 'coffer.deviceId';

function getDeviceIdentifier(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function clearDeviceIdentifier(): void {
  localStorage.removeItem(DEVICE_KEY);
}

// 这两个薄封装让依赖注入的签名保持简单
import { sync as apiSync, getRevisionDate as apiRevisionDate } from '@coffer/api';
function syncVia(http: HttpClient) { return apiSync(http, ''); }
function getRevisionDateVia(http: HttpClient) { return apiRevisionDate(http, ''); }
