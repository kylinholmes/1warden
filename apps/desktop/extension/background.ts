import { accountKey, lockedAccount } from '../src/application/account-target';
/**
 * MV3 service worker —— 扩展的大脑。
 *
 * ## 职责
 *
 * - 持有解锁会话（`ext.storage.session`，见 session-store.ts）
 * - 响应 popup 的解锁 / 查询 / 填充 / 锁定请求
 * - **计算填哪个字段**，并把值直接注入页面（值不经过 content script）
 *
 * ## 网络
 *
 * 直接 `fetch`。扩展的 origin 是 `chrome-extension://…`，但**有 host
 * permission 时不受 CORS 限制** —— 这正是桌面端做不到、必须把 HTTP 搬到
 * Rust 侧的那件事，在扩展里天然不是问题。
 *
 * ## ⚠️ service worker 会被杀
 *
 * 约 30 秒空闲后浏览器就会终止它。所以**任何跨请求的状态都必须落在
 * storage 里**，模块变量随时可能归零。
 */
import { ext } from './ext-api';
import { installExtensionHost } from './host-impl';
import {
  VaultClient, classifyFields, matchItemsByUrl, decideCapture,
    type AccountInfo, type FieldDescriptor, type VaultItem, type CaptureDecision,
  totpCode,
} from '@1warden/vault';
import { host } from '@1warden/ui';
import { SessionStore, restrictSessionToTrustedContexts, type StorageArea } from './session-store';
import { syncCache, kdfCache, summarise } from '@1warden/ui';
import { fillFields, readFieldValues, type FillEntry, type FillOutcome } from './fill';
import { handleWebauthn, type WebauthnPayload } from './webauthn';
import { createProfileCache } from '../src/application/profile-cache';
import { createVaultService } from '../src/application/service';
import type { ApplicationMethod, ApplicationRequest, SiteContext } from '../src/application/types';
import { authorizeRequest, createApplicationDispatcher, createSerialRunner, serializeError } from './application-rpc';
import { createClipboardStore } from './clipboard-store';
import { CONNECTION_DRAFT_KEY } from './connection-draft';
import { CLIPBOARD_CLEAR_MS } from '@1warden/ui/clipboard';
import type { InlineAccounts, InlineRequest } from './inline-accounts';

/** 会话区：只在内存、浏览器重启即清空 */
const storageWrites = createSerialRunner();
const sessionArea: StorageArea = {
  get: (keys) => ext.storage.session.get(keys as string | string[]),
  set: (items) => storageWrites(() => ext.storage.session.set(items)),
  remove: (keys) => storageWrites(() => ext.storage.session.remove(keys as string | string[])),
  clear: () => storageWrites(() => ext.storage.session.clear()),
};

const sessions = new SessionStore(sessionArea);

/** 本次模块求值的随机标识 —— 排查用。见 `1warden:webauthn` 的幂等说明 */
const INSTANCE = Math.random().toString(36).slice(2, 6);
console.debug('[onewarden] SW 实例 ' + INSTANCE + ' 启动');

/**
 * 追踪缓冲 —— 把诊断写进 `ext.storage.session` 而不是只打控制台。
 *
 * ⚠️ **为什么必须这样**：MV3 的 service worker 会被杀又被唤醒，
 * 实测一次运行里能出现**两个实例**，而调试器只连得上其中一个 ——
 * 另一个实例的 console 输出根本收不到，排查时会得到
 * 「这个请求像是没被处理过」这种误导性的结论（我在这上面绕了好几轮）。
 *
 * 写进 session 区之后，无论哪个实例产生的都能在**任意一个**扩展上下文里读到。
 * 只留最近 120 行，且只在 passkey 路径上写 —— 那不是高频操作。
 */
const TRACE_KEY = '1warden.trace';

async function trace(line: string): Promise<void> {
  try {
    const got = await ext.storage.session.get(TRACE_KEY);
    const arr = Array.isArray(got[TRACE_KEY]) ? (got[TRACE_KEY] as string[]) : [];
    arr.push(`[${INSTANCE}] ${line}`);
    await ext.storage.session.set({ [TRACE_KEY]: arr.slice(-120) });
  } catch (e) {
    // 追踪本身绝不能影响功能 —— 但**也不能完全静默**：
    // 早先这里是空 catch，于是「缓冲是空的」既可能是没写、也可能是写失败，
    // 排查时分不出来。只报第一次。
    if (!traceBroken) {
      traceBroken = true;
      console.warn('[onewarden] 追踪写入失败（之后不再报）：', e);
    }
  }
}

let traceBroken = false;

/**
 * 再上一道锁：让 content script 读不到会话区。
 *
 * 具体的判断与两个浏览器的差异都在 `restrictSessionToTrustedContexts` 里 ——
 * **能力检测**而不是 `.catch()`，因为属性不存在时抛的是同步 TypeError，
 * `.catch()` 接不住（Firefox 上真的把整个 background 崩掉了）。
 */
restrictSessionToTrustedContexts(ext.storage.session);

/* 宿主要在每个上下文各装一次 —— service worker 和弹窗是**两个**上下文 */
installExtensionHost();

/** 设备标识不是秘密，落盘无妨；但也不能每次启动都换（会在设备列表里堆一堆） */
const deviceStore = {
  async get(): Promise<string | null> {
    const got = await ext.storage.local.get('1warden.deviceId');
    return typeof got['1warden.deviceId'] === 'string' ? got['1warden.deviceId'] : null;
  },
  async set(id: string): Promise<void> {
    await ext.storage.local.set({ '1warden.deviceId': id });
  },
  async clear(): Promise<void> {
    await ext.storage.local.remove('1warden.deviceId');
  },
};

let client: VaultClient | null = null;
let lockCleanup: Promise<void> = Promise.resolve();
let restoration: { client: VaultClient; promise: Promise<VaultClient> } | null = null;
const authenticating = new WeakSet<VaultClient>();
// A new worker has no selected identity yet; an explicit Add Account selection has a known null identity.
const resolvedClients = new WeakSet<VaultClient>();

function newClient(): VaultClient {
  const c = new VaultClient({
    /*
     * 走宿主。扩展端这一步是直接 `fetch`（有 host permission，不受 CORS 限制），
     * 桌面端走 Rust —— 差异只在这一行，见 `@1warden/ui/host`。
     */
    fetchImpl: host().fetch,
    deviceStore,
    // Browser alarms own the absolute deadline; an in-memory timer would reset on every worker restore.
    autoLockMs: 0,
    onSync: (syncing) => {
      if (!syncing && c === client) void runSerialized(async () => {
        if (c !== client) return;
        await persistState();
        if (c !== client) return;
        notifyChanged();
      }).catch(reportFailure);
    },
    /*
     * 上次同步的密文缓存 —— 解锁后先拿它把界面填上，再去问服务端。
     * 桌面端早就有，扩展端一直缺（每次解锁都要等一整轮网络）。
     */
    syncCache,
    /* 省掉解锁时的那次 prelogin —— 桌面端一直有，扩展端以前没有 */
    kdfCache,
  });
  return c;
}

/**
 * ⚠️ **进程重启后的恢复**，而且时机必须是确定的。
 *
 * service worker 每次被唤醒都会重新执行这个模块，此时 `client` 是新的、
 * 会话是 `loggedOut` —— 而 `ext.storage.session` 里的密钥**还在**。
 * 不灌回去的话，所有已解锁的操作都会报「保险库未解锁」，而用户刚刚才解锁过。
 *
 * 消息可能在这段恢复完成**之前**就到达，所以 `handle()` 一律先 await 它。
 * 靠「恢复大概来得及」是碰运气 —— 而这个 bug 的表现是偶发的，
 * 恰恰是最难查的那种。
 */
async function restoreFromStorage(): Promise<VaultClient> {
  await lockCleanup.catch(() => {});
  const c = getClient();
  // Authentication owns the live session until its first durable snapshot exists.
  // Re-reading storage meanwhile could overwrite it or mistake its absent deadline for expiry.
  if (authenticating.has(c)) return c;
  if (restoration?.client === c) return restoration.promise;
  const pending = { client: c, promise: restoreClientFromStorage(c) };
  restoration = pending;
  try { return await pending.promise; }
  finally { if (restoration === pending) restoration = null; }
}

async function restoreClientFromStorage(c: VaultClient): Promise<VaultClient> {
  if (c.getSession().isUnlocked()) {
    const deadline = await sessions.expiresAt();
    if (c !== client) return getClient();
    if (deadline === null || deadline <= Date.now()) {
      // Expiry is a lock boundary too: retire pending requests and their queue.
      await dispatchApplication({ method: 'lock', args: [] });
    }
    return getClient();
  }
  const stored = await sessions.load();
  if (c !== client) return getClient();
  if (stored) {
    c.restore(stored);
    resolvedClients.add(c);
    await scheduleAutoLock();
  } else {
    await sessionArea.remove([PENDING_KEY, WA_DONE_KEY, WA_CLAIM_KEY]);
    const account = await sessions.loadAccount();
    if (c !== client) return getClient();
    if (account && !c.getSession().account) c.getSession().setAccount(account);
    resolvedClients.add(c);
  }
  return c;
}

async function unlockedClient(): Promise<VaultClient> {
  return restoreFromStorage();
}

function getClient(): VaultClient {
  client ??= newClient();
  return client;
}

function requireCurrentClient(c: VaultClient): void {
  if (c !== client || !c.getSession().isUnlocked()) throw new Error('请求已取消，保险库已锁定');
}

let profileCache: ReturnType<typeof createProfileCache> | undefined;

function serviceFor(c: VaultClient) {
  profileCache ??= createProfileCache(host().storage);
  const application = createVaultService(c, profileCache);
  const authenticate = async (operation: () => Promise<void>) => {
    authenticating.add(c);
    try { await operation(); }
    catch (error) { authenticating.delete(c); throw error; }
    // Success remains protected until persistState establishes the session deadline.
  };
  return {
    ...application,
    snapshot: async () => {
      const snapshot = await application.snapshot();
      const unlockedAccounts = await sessions.unlockedAccounts();
      if (snapshot.status === 'unlocked' && snapshot.account) {
        const key = accountKey(snapshot.account);
        if (!unlockedAccounts.includes(key)) unlockedAccounts.push(key);
      }
      return { ...snapshot, unlockedAccounts };
    },
    connect: (...args: Parameters<typeof application.connect>) => authenticate(() => application.connect(...args)),
    connectWithTwoFactor: (...args: Parameters<typeof application.connectWithTwoFactor>) => authenticate(() => application.connectWithTwoFactor(...args)),
    unlock: (...args: Parameters<typeof application.unlock>) => authenticate(() => application.unlock(...args)),
    switchAccount: (target: Parameters<typeof application.switchAccount>[0]) => {
      const selected = target ? lockedAccount(target) : null;
      const previousAccount = c.getSession().account;
      // Retire pending work and the live key, preserving the independent trusted-memory slot.
      c.logout();
      authenticating.delete(c);
      client = newClient(); restoration = null;
      const selectedClient = getClient();
      if (selected) selectedClient.getSession().setAccount(selected);
      resolvedClients.add(selectedClient);
      service = serviceFor(selectedClient);
      lockCleanup = lockCleanup.catch(() => {}).then(async () => {
        if (selectedClient !== client) return;
        const restored = await sessions.select(selected);
        if (selectedClient !== client) return;
        if (restored) selectedClient.restore(restored);
        await sessionArea.remove([PENDING_KEY, WA_DONE_KEY, WA_CLAIM_KEY]);
        if (selected) await sessionArea.remove(CONNECTION_DRAFT_KEY);
        else if (previousAccount) await sessionArea.set({ [CONNECTION_DRAFT_KEY]: { serverUrl: '', email: '', error: null,
          returnAccount: { serverUrl: previousAccount.serverUrl, email: previousAccount.email },
        } });
        else await sessionArea.remove(CONNECTION_DRAFT_KEY);
        await scheduleAutoLock();
        if (restored) await refreshBadges(); else await clearBadges();
      });
      return lockCleanup;
    },
    lock: () => retireClient(c, false),
    logout: () => retireClient(c, true),
  };
}

/** Pending network/authentication continuations retain only this retired client. */
function retireClient(c: VaultClient, forgetAccount: boolean, clearPresentation = forgetAccount): Promise<void> {
  const previousAccount = c.getSession().account;
  const resolved = previousAccount !== null || resolvedClients.has(c);
  // Undefined asks storage to identify its active slot; null deliberately preserves all parked slots.
  const owner = resolved ? previousAccount : undefined;
  const account = forgetAccount ? null : previousAccount;
  let clearProfile: Promise<void | undefined> | undefined;
  if (clearPresentation) {
    if (previousAccount) clearProfile = profileCache?.clear(previousAccount);
    else if (!resolved) clearProfile = sessions.loadAccount().then((stored) => stored ? profileCache?.clear(stored) : undefined);
  }
  if (forgetAccount) c.logout(); else c.lock();
  if (c !== client) return lockCleanup;
  client = newClient();
  if (account) client.getSession().setAccount(account);
  if (resolved) resolvedClients.add(client);
  service = serviceFor(client);
  // clear() invalidates restoration synchronously, then drains already-started storage writes.
  lockCleanup = Promise.all([clearSession(forgetAccount, owner), clearProfile]).then(() => {});
  return lockCleanup;
}

// ── 消息 ──

interface FieldsState {
  url: string;
  fields: FieldDescriptor[];
  isLoginForm: boolean;
}

/** 最近一次各标签页上报的字段 —— 覆盖写入即可，不需要历史 */
const tabFields = new Map<number, FieldsState>();

/**
 * 待用户确认的「保存 / 更新」。
 *
 * ⚠️ 存在 session 区而不是模块变量里：service worker 随时会被杀，
 * 用户在弹窗里点「保存」时可能已经是几分钟之后了。
 * 那里面**有明文密码**，所以只能用 session 区（内存、content script 读不到）。
 */
const PENDING_KEY = '1warden.pending';

interface PendingCapture {
  tabId: number;
  url: string;
  username: string | null;
  password: string;
  decision: CaptureDecision;
}

async function setPending(p: PendingCapture | null, tabId?: number, owner = getClient()): Promise<void> {
  const got = await ext.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  if (p === null) {
    if (tabId !== undefined) delete map[String(tabId)];
  } else {
    map[String(p.tabId)] = p;
  }
  requireCurrentClient(owner);
  await sessionArea.set({ [PENDING_KEY]: map });
}

async function getPending(tabId: number): Promise<PendingCapture | null> {
  const got = await ext.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  return map[String(tabId)] ?? null;
}

type Request =
  | ApplicationRequest
  | InlineRequest
  | { type: '1warden:connect'; serverUrl: string; email: string; masterPassword: string }
  | { type: '1warden:lock' }
  | { type: '1warden:list' }
  | { type: '1warden:matches'; url: string }
  | { type: '1warden:context' }
  | { type: '1warden:fill'; itemId: string; tabId: number; application?: boolean }
  | { type: '1warden:pending'; tabId?: number }
  | { type: '1warden:save-capture'; tabId?: number }
  | { type: '1warden:dismiss-capture'; tabId?: number }
  | { type: '1warden:copy'; itemId: string; field: 'username' | 'password' | 'totp' }
  | { type: '1warden:clipboard-copied'; value: string }
  | { type: '1warden:webauthn'; payload: unknown };

const AUTO_LOCK_ALARM = '1warden:auto-lock';
const CLIPBOARD_ALARM = '1warden:clipboard-clear';
const runSerialized = createSerialRunner();
let service = serviceFor(getClient());
const dispatchApplication = createApplicationDispatcher(() => service, {
  run: runSerialized,
  beforeRequest: async () => { await restoreFromStorage(); },
  afterMutation: persistState,
  onChanged: notifyChanged,
});

function reportFailure(error: unknown): void {
  console.error('[onewarden] 后台操作失败：', error);
}

function notifyChanged(): void {
  void ext.runtime.sendMessage({ type: '1warden-internal:changed' }).catch(() => {});
}

async function scheduleAutoLock(): Promise<void> {
  const deadline = await sessions.nextExpiry();
  if (deadline !== null) await ext.alarms.create(AUTO_LOCK_ALARM, { when: deadline });
  else await ext.alarms.clear(AUTO_LOCK_ALARM);
}

async function clearSession(forgetAccount = false, account?: AccountInfo | null): Promise<void> {
  await sessions.clear({ forgetAccount, ...(account !== undefined ? { account } : {}) });
  await sessionArea.remove([PENDING_KEY, WA_DONE_KEY, WA_CLAIM_KEY]);
  await scheduleAutoLock();
  await clearBadges();
}

async function persistState(method?: ApplicationMethod, succeeded = true): Promise<void> {
  if (method === 'lock' || method === 'logout' || method === 'switchAccount') { await lockCleanup; return; }
  const c = getClient();
  const authentication = method === 'connect' || method === 'connectWithTwoFactor' || method === 'unlock';
  try {
    if (c.getSession().isUnlocked()) {
      try {
        if (succeeded && authentication) {
          await sessions.start(c.exportState());
          await sessionArea.remove(CONNECTION_DRAFT_KEY);
        } else {
          await sessions.save(c.exportState());
        }
        await scheduleAutoLock();
        if (c !== client) return;
        await refreshBadges();
      } catch (error) {
        // Never leave an acknowledged write with an older recoverable plaintext snapshot.
        if (c === client) await retireClient(c, false);
        throw error;
      }
    } else {
      await clearSession(c.getSession().status === 'loggedOut');
    }
  } finally {
    if (authentication) authenticating.delete(c);
  }
}

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    void (async () => {
      const c = client;
      const activeExpired = await sessions.expire();
      if (c !== client) return;
      if (activeExpired) await dispatchApplication({ method: 'lock', args: [] });
      else await scheduleAutoLock();
    })().catch(reportFailure);
  }
  if (alarm.name === CLIPBOARD_ALARM) void firefoxClipboard.resume().catch(reportFailure);
});

ext.runtime.onMessage.addListener((msg: unknown, sender, respond) => {
  const req = msg as { type?: unknown; application?: boolean } | null;
  if (typeof req?.type !== 'string' || !req.type.startsWith('1warden:')) return undefined;
  const application = req.type === '1warden:application' || req.type === '1warden:context'
    || req.type === '1warden:clipboard-copied' || req.application === true;
  const fail = (error: unknown) => {
    const serialized = serializeError(error);
    respond(application ? { ok: false, error: serialized } : { error: serialized.message, ...serialized });
  };
  try { authorizeRequest(req.type, sender, ext.runtime); } catch (error) { fail(error); return undefined; }

  // Preserve the originating button's gesture on browsers that require it.
  // Unlock happens only in the trusted extension popup, never in page DOM.
  if (req.type === '1warden:inline-unlock') {
    try {
      if (!ext.action.openPopup) throw new Error('unsupported');
      void ext.action.openPopup().then(() => respond({ ok: true })).catch(() =>
        respond({ error: '请点击浏览器工具栏中的 1Warden 图标解锁，然后回到此输入框选择账号。' }));
    } catch {
      respond({ error: '请点击浏览器工具栏中的 1Warden 图标解锁，然后回到此输入框选择账号。' });
    }
    return true;
  }

  if (req.type === '1warden:fields') {
    const m = msg as { fields?: FieldDescriptor[]; isLoginForm?: boolean };
    const from = sender.tab!.id!;
    if (Array.isArray(m.fields) && typeof m.isLoginForm === 'boolean') {
      tabFields.set(from, { url: sender.url!, fields: m.fields, isLoginForm: m.isLoginForm });
      void updateBadge(from, m.isLoginForm).catch(reportFailure);
    }
    return undefined;
  }
  if (req.type === '1warden:submitted') {
    void runSerialized(async () => {
      const owner = getClient();
      await restoreFromStorage();
      if (owner !== client) throw new Error('请求已取消，保险库已锁定');
      await onSubmitted(sender.tab?.id, sender.url);
      notifyChanged();
    }).catch(reportFailure);
    return undefined;
  }

  // Vault mutations share a queue; lock retires the current generation immediately.
  const result = req.type === '1warden:application'
    ? dispatchApplication(msg)
    : req.type === '1warden:clipboard-copied'
    ? handle(msg as Request, sender)
    : req.type === '1warden:lock'
    ? dispatchApplication({ method: 'lock', args: [] }).then(() => ({ ok: true }))
    : runSerialized(async () => {
      const owner = getClient();
      await restoreFromStorage();
      if (owner !== client) throw new Error('请求已取消，保险库已锁定');
      return handle(msg as Request, sender);
    });
  void result.then((value) => respond(application ? { ok: true, result: value } : value)).catch(fail);
  return true;
});

/**
 * 已完成的 passkey 请求结果，按「标签页 + 帧 + 请求 id」索引。
 *
 * ## ⚠️ 为什么必须落在 `ext.storage.session` 而不是模块变量里
 *
 * MV3 的 service worker 会被杀又被唤醒，每次唤醒都**重新求值一次这个模块**。
 * 模块级的 `Map` 那时是空的 —— 于是同一个请求会被再处理一遍。
 *
 * 实测到的现象：一次 create 被执行了两次，两遍的模块级序号**都是 #1**
 * （计数器被重置），各自建了一把密钥；后一遍从存储恢复出来的会话是
 * **第一遍落盘之前**的快照，于是它整条写回去，把第一遍的凭据覆盖掉了。
 *
 * 症状极具迷惑性：页面拿到的是第一遍的 credentialId（它先返回），
 * 库里躺着第二遍的 —— 之后用 allowCredentials 登录报「没有可用的 passkey」，
 * 看起来像匹配逻辑坏了，而匹配逻辑完全正确。
 *
 * `storage.session` 是内存存储（不落盘）、只对受信任上下文可见，
 * 但**跨 SW 重启存活** —— 正是这里需要的那一档。存进去的都是要给页面的东西
 * （credentialId / clientDataJSON / 签名），本来就不是秘密。
 */
const WA_DONE_KEY = '1warden.webauthnDone';

/** Request counters restart on navigation; include the browser's document identity and origin. */
function waKey(sender: chrome.runtime.MessageSender, id: number): string {
  return JSON.stringify([sender.tab?.id ?? -1, sender.frameId ?? 0,
    sender.origin ?? new URL(sender.url!).origin, sender.documentId ?? sender.url, id]);
}

async function readDone(key: string, owner: VaultClient): Promise<Record<string, unknown> | null> {
  const got = await ext.storage.session.get(WA_DONE_KEY);
  requireCurrentClient(owner);
  const map = (got[WA_DONE_KEY] ?? {}) as Record<string, Record<string, unknown>>;
  return map[key] ?? null;
}

/**
 * 抢一个「我正在处理这个请求」的认领。
 *
 * ⚠️ `ext.storage` 没有原子的比较并写入 —— 只写不读会有竞态，
 * 所以**写完再读回来确认赢的是自己**。两个实例同时写时后写的赢，
 * 先写的那次读回来会发现不是自己，于是让位。
 */
async function claim(key: string, owner: VaultClient): Promise<boolean> {
  const got = await ext.storage.session.get(WA_CLAIM_KEY);
  requireCurrentClient(owner);
  const map = (got[WA_CLAIM_KEY] ?? {}) as Record<string, number>;

  // ⚠️ 认领**必须会过期**。持有它的实例可能半路被杀（这正是我们面对的那个
  // 场景），认领会永远留着 —— 后来者干等十秒然后报错，比不做互斥还糟。
  const held = map[key];
  if (held !== undefined && Date.now() - held < CLAIM_TTL_MS) return false;

  // 只留最近几十个，别让这张表无限长
  for (const k of Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - 32))) delete map[k];
  map[key] = Date.now();
  // Account cleanup drains this queue; ownership may change while a write waits its turn.
  await storageWrites(async () => {
    requireCurrentClient(owner);
    await ext.storage.session.set({ [WA_CLAIM_KEY]: map });
  });
  requireCurrentClient(owner);

  // ⚠️ 写完要**等一小段随机时间再读回来**。
  //
  // 两个实例可能几乎同时读（都看到没被认领）→ 都写 → 都回读。
  // 如果回读发生得太快，可能在自己写完之后、对方写之前完成，于是两边都以为
  // 自己赢了 —— 互斥形同虚设。加抖动把「写」和「回读」错开，让后来者一定被看见。
  //
  // 这是最后一道保险：实测过没有它时好时坏（同一份代码连着跑两次，
  // 一次全绿一次红），而这种「偶尔丢凭据」的 bug 正是最难被用户说清楚的。
  await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
  requireCurrentClient(owner);

  const back = await ext.storage.session.get(WA_CLAIM_KEY);
  requireCurrentClient(owner);
  const after = (back[WA_CLAIM_KEY] ?? {}) as Record<string, number>;
  // 不是自己写的 → 有人抢先。两个实例同时写时后写的赢，先写的读到不是自己就让位
  return after[key] === map[key];
}

async function releaseClaim(key: string, owner: VaultClient): Promise<void> {
  const got = await ext.storage.session.get(WA_CLAIM_KEY);
  requireCurrentClient(owner);
  const map = (got[WA_CLAIM_KEY] ?? {}) as Record<string, number>;
  delete map[key];
  await storageWrites(async () => {
    requireCurrentClient(owner);
    await ext.storage.session.set({ [WA_CLAIM_KEY]: map });
  });
  requireCurrentClient(owner);
}

const WA_CLAIM_KEY = '1warden.webauthnClaim';

/** 认领的有效期。超过它视为持有者已死，后来者可以接管 */
const CLAIM_TTL_MS = 30_000;

async function writeDone(key: string, reply: Record<string, unknown>, owner: VaultClient): Promise<void> {
  const got = await ext.storage.session.get(WA_DONE_KEY);
  requireCurrentClient(owner);
  const map = (got[WA_DONE_KEY] ?? {}) as Record<string, Record<string, unknown>>;
  map[key] = reply;
  // 只留最近几十条 —— 页面开一整天的话这个表不该无限长下去
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - 32))) delete map[k];
  await storageWrites(async () => {
    requireCurrentClient(owner);
    await ext.storage.session.set({ [WA_DONE_KEY]: map });
  });
  requireCurrentClient(owner);
}

async function runWebauthn(payload: unknown, senderOrigin: string | undefined, c: VaultClient): Promise<Record<string, unknown>> {
  // ⚠️ 只认客户端这一份状态。
  // 原先这里还额外读了 `sessions.load()` 来判断「解锁了没有」，
  // 于是同一个事实有了两个来源 —— 而它们会不一致（存储里没有、
  // 但客户端刚被 connect 解锁过），表现为用户刚解锁却报「保险库未解锁」。
  // 密钥在不在，`getKey()` 说了算。
  requireCurrentClient(c);
  const key = c.getSession().getKey();
  if (!key) return { ok: false, error: `保险库未解锁（${c.getSession().status}）` };

  const result = await handleWebauthn(payload as WebauthnPayload, senderOrigin, {
    items: () => c.getSession().items,
    userKey: () => key,
    refresh: async () => { requireCurrentClient(c); await c.refresh(); requireCurrentClient(c); },
    isUnlocked: () => c === client && c.getSession().isUnlocked(),
    trace,
    persist: async (changed) => {
      for (const item of changed) { requireCurrentClient(c); await c.saveItem(item); }
      requireCurrentClient(c);
      // 和 save-capture 一样：存完必须刷一次会话快照，
      // 否则下一次读到的还是旧的，第二次断言会拿着过期的计数去存
      await persistState();
      notifyChanged();
    },
  });
  // passkey 失败在页面上只会表现成一句「NotAllowedError」，
  // 看不出是 rpId 被拒、没有可用凭据、还是存不进保险库。
  // 这里是唯一能留下原因的地方。
  if (result['ok'] === false) console.warn('[onewarden] passkey 失败：', result['error']);
  return result;
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const activeClient = getClient();
  switch (req.type) {
    case '1warden:inline-accounts': {
      await requireInlineDocument(sender);
      const session = activeClient.getSession();
      requireInlineOwner(activeClient);
      return {
        unlocked: session.isUnlocked(),
        accounts: session.isUnlocked() ? matchItemsByUrl(session.items, sender.url!)
          .filter((item) => item.type === 'login' && item.login !== null)
          .map((item) => ({ id: item.id, title: item.name, username: item.login!.username ?? '' })) : [],
      } satisfies InlineAccounts;
    }
    case '1warden:inline-fill': {
      await requireInlineDocument(sender);
      requireCurrentClient(activeClient);
      if (typeof req.itemId !== 'string') throw new Error('无效的账号选择');
      const item = matchItemsByUrl(activeClient.getSession().items, sender.url!)
        .find((candidate) => candidate.id === req.itemId && candidate.type === 'login');
      if (!item?.login) throw new Error('这个账号与当前网站不匹配，请重新选择');
      const tabId = sender.tab!.id!;
      const fields = await readFieldsFrom(tabId);
      const entries = await buildEntries(classifyFields(fields), item);
      await requireInlineDocument(sender);
      requireCurrentClient(activeClient);
      if (entries.length === 0) throw new Error('这个页面上找不到可以填的字段');
      const [injection] = await ext.scripting.executeScript({
        target: sender.documentId ? { tabId, documentIds: [sender.documentId] } : { tabId, frameIds: [0] },
        func: fillFields,
        args: [entries, sender.url!],
      });
      const outcomes = (injection?.result ?? []) as FillOutcome[];
      if (outcomes.length !== entries.length || outcomes.some((outcome) => !outcome.ok || !outcome.verified)) {
        throw new Error('未能填充，请检查页面后重新选择账号');
      }
      // Do not echo entries, item details, or page values to the content script.
      return { ok: true };
    }
    case '1warden:connect':
      await service.connect({ serverUrl: req.serverUrl, email: req.email, masterPassword: req.masterPassword });
      requireCurrentClient(activeClient);
      await persistState('connect');
      notifyChanged();
      return { ok: true, itemCount: getClient().getSession().items.length };
    case '1warden:lock':
      await service.lock();
      await persistState('lock');
      notifyChanged();
      return { ok: true };
    case '1warden:list': {
      const snapshot = await service.snapshot();
      return { unlocked: snapshot.status === 'unlocked', account: snapshot.account, items: snapshot.items };
    }
    case '1warden:matches': {
      const session = getClient().getSession();
      return { unlocked: session.isUnlocked(), items: matchItemsByUrl(session.items, req.url).map(summarise) };
    }
    case '1warden:context': {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id ?? null;
      const url = tab?.url ?? '';
      const session = getClient().getSession();
      const capture = tabId !== null && session.isUnlocked() ? await getPending(tabId) : null;
      return {
        tabId, url,
        matchedIds: session.isUnlocked() ? matchItemsByUrl(session.items, url).map((i) => i.id) : [],
        pending: capture && capture.decision.kind !== 'none' ? {
          url: capture.url, username: capture.username, action: capture.decision.kind,
          itemId: capture.decision.kind === 'update' ? capture.decision.itemId : null,
        } : null,
      } satisfies SiteContext;
    }
    case '1warden:clipboard-copied':
      if (typeof req.value !== 'string') throw new Error('无效的剪贴板内容');
      await scheduleClipboard(req.value);
      return;
    case '1warden:copy': {
      // Compatibility for browser regression scripts. Shared UI reveals then copies locally.
      const detail = await service.getItem(req.itemId);
      const value = req.field === 'username' ? detail.login?.username
        : req.field === 'totp' ? (await service.totp(req.itemId))?.code
        : await service.reveal(req.itemId, { kind: 'password' });
      if (value == null) throw new Error('找不到这个字段');
      return { value, clearAfterSeconds: CLIPBOARD_CLEAR_MS / 1000 };
    }
    case '1warden:fill': {
      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');

      const item = session.items.find((i) => i.id === req.itemId);
      if (!item?.login) throw new Error('这条记录没有可填充的登录信息');

      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) throw new Error('找不到目标标签页');

      // 以**当前**页面为准重新读一次字段 —— 上报之后页面可能已经变了
      const fields = await readFieldsFrom(tabId);
      const plan = classifyFields(fields);
      const entries = await buildEntries(plan, item);
      requireCurrentClient(activeClient);
      if (entries.length === 0) throw new Error('这个页面上找不到可以填的字段');

      const [injection] = await ext.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: fillFields,
        args: [entries],
      });

      const outcomes = (injection?.result ?? []) as FillOutcome[];
      const failed = outcomes.filter((o) => !o.ok || !o.verified);
      if (req.application && failed.length > 0) throw new Error('部分字段未能填充，请检查页面');
      return { ok: failed.length === 0, outcomes, failed };
    }

    case '1warden:pending': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { pending: null };
      const p = await getPending(tabId);
      if (p === null) return { pending: null };
      // 先取出来，TS 才能对判别联合做收窄（透过 p.decision.kind 访问是收窄不了的）
      const decision = p.decision;
      // ⚠️ 只回展示需要的字段 —— 密码留在 background，保存时现取现用
      return {
        pending: {
          url: p.url,
          username: p.username,
          action: decision.kind,
          itemId: decision.kind === 'update' ? decision.itemId : null,
        },
      };
    }

    case '1warden:save-capture': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) throw new Error('找不到标签页');
      const p = await getPending(tabId);
      if (p === null) throw new Error('没有待保存的登录信息');

      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');

      const c = await unlockedClient();
      requireCurrentClient(activeClient);
      const decision = p.decision;
      if (decision.kind === 'update') {
        const existing = session.items.find((i) => i.id === decision.itemId);
        if (!existing) throw new Error('要更新的条目已经不存在了');
        await c.saveItem({
          ...existing,
          login: {
            ...(existing.login ?? { totp: null, uris: [], passwordRevisionDate: null, fido2Credentials: [] }),
            username: p.username ?? existing.login?.username ?? null,
            password: p.password,
          },
          // 旧密码进历史 —— 改错了还能找回来。1Password 也是这么做的
          passwordHistory: existing.login?.password
            ? [{ password: existing.login.password, lastUsedDate: new Date().toISOString() },
               ...existing.passwordHistory].slice(0, 5)
            : existing.passwordHistory,
        });
      } else {
        await c.saveItem(newLoginItem(p.url, p.username, p.password));
      }

      // 保存后同步一次会话快照，否则下次读到的还是旧的
      // ⚠️ 用客户端的 `exportState()`，不是自己照着字段列表拼一份 ——
      // 拼的时候漏掉传输层，恢复出来就是一个「读得了、写不了」的客户端
      requireCurrentClient(activeClient);
      await persistState();

      await setPending(null, tabId, activeClient);
      await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      notifyChanged();
      return { ok: true };
    }

    case '1warden:webauthn': {
      /**
       * ⚠️ **幂等：同一个请求 id 只执行一次。**
       *
       * MAIN world 每 250ms 重发一次（它跑在 `document_start`，转发脚本跑在
       * `document_idle`，第一次必然打空），而一次 create 要跑几百毫秒到几秒。
       * content script 那层也在去重，但那是页面里的一份内存，扛不住所有情况。
       *
       * 不幂等的后果不是「多做一次无用功」，而是**丢数据**：第二次拿到的是
       * 过期快照（凭据列表还是空的），写回去就把第一次刚存进去的凭据覆盖掉了。
       * 用户看到的是「注册好像成功了」，直到下次登录才被告知没有可用的 passkey。
       */
      const reqId = (req.payload as { id?: number } | null)?.id;
      const op = (req.payload as { op?: string } | null)?.op ?? '?';
      await trace(`收到 ${op} id=${String(reqId)}`);
      if (typeof reqId !== 'number') return await runWebauthn(req.payload, sender.origin ?? new URL(sender.url!).origin, activeClient);

      const key = waKey(sender, reqId);

      const done = await readDone(key, activeClient);
      requireCurrentClient(activeClient);
      if (done) return done;

      /**
       * ⚠️ **跨实例的互斥。**
       *
       * 实测到的：同一个请求会被**两个 service worker 实例并发**处理
       * （SW 重启期间的交接），各自跑一遍 create。两遍都读到「这条条目还没有
       * 凭据」（因为第一遍还没落盘），于是都往里写 —— 后者覆盖前者。
       * 页面拿到第一遍的 credentialId，库里躺着第二遍的。
       *
       * 内存里的锁（`createLocks`）跨不了实例，所以「认领」也必须放进存储。
       * 抢不到的那个**等**对方的结果，而不是自己也跑一遍。
       */
      if (!(await claim(key, activeClient))) {
        // 抢不到就等对方 —— 不自己也跑一遍
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const r = await readDone(key, activeClient);
          requireCurrentClient(activeClient);
          if (r) return r;
        }
        return { ok: false, error: '另一个 passkey 请求还在处理中，请重试' };
      }

      const result = await runWebauthn(req.payload, sender.origin ?? new URL(sender.url!).origin, activeClient);
      requireCurrentClient(activeClient);
      // ⚠️ 失败**不**记缓存：让页面能重试。成功的才记 ——
      // 而成功的结果不记的话，SW 重启后同一个请求会再跑一遍并覆盖。
      if (result['ok'] === true) await writeDone(key, result, activeClient);
      else await releaseClaim(key, activeClient);
      return result;
    }

    case '1warden:dismiss-capture': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { ok: true };
      await setPending(null, tabId, activeClient);
      await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      return { ok: true };
    }

    default: throw new Error(`未知请求：${req.type}`);
  }
}

/** Browser-supplied sender identity is the authority; request payload URLs are never used. */
async function requireInlineDocument(sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url) throw new Error('找不到目标网页');
  const tab = await ext.tabs.get(sender.tab.id);
  if (tab.url !== sender.url) throw new Error('网页地址已改变，请重新选择账号');
}

function requireInlineOwner(owner: VaultClient): void {
  if (owner !== client) throw new Error('保险库状态已改变，请重新选择账号');
}

/**
 * 把密码计划翻译成「第几个框填什么值」。
 *
 * 只有这里——background——同时握有字段位置与明文。content script 从头到尾
 * 只给出位置，拿不到值。
 */
async function buildEntries(
  plan: ReturnType<typeof classifyFields>,
  item: VaultItem,
): Promise<FillEntry[]> {
  const login = item.login;
  const entries: FillEntry[] = [];
  if (!login) return entries;
  if (plan.username !== undefined && login.username !== null) {
    entries.push({ index: plan.username, value: login.username });
  }
  if (plan.password !== undefined && login.password !== null) {
    entries.push({ index: plan.password, value: login.password });
  }
  // 注册/改密码场景下 newPassword 也该被填上 —— 但要用**同一条记录的密码**，
  // 不在这里生成新密码：生成属于用户的显式动作，不该由填充顺手做掉
  if (plan.newPassword !== undefined && login.password !== null) {
    entries.push({ index: plan.newPassword, value: login.password });
  }
  if (plan.confirmPassword !== undefined && login.password !== null) {
    entries.push({ index: plan.confirmPassword, value: login.password });
  }

  // 验证码也填。它确实只有 30 秒有效期，但填充正是发生在**提交前那一刻** ——
  // 不进这一步，用户就得自己切到弹窗、复制、再切回来，多两次上下文切换。
  // 万一填晚了，页面会提示验证码错误，重填一次即可，代价很小。
  if (plan.totp !== undefined && login.totp !== null) {
    // `totpCode` 遇到不合法的密钥返回 null 而不是抛错 —— 那种情况就不填，
    // 其余字段照常
    const code = await totpCode(item);
    if (code) entries.push({ index: plan.totp, value: code.code });
  }
  return entries;
}

async function readFieldsFrom(tabId: number): Promise<FieldDescriptor[]> {
  try {
    const [res] = await ext.scripting.executeScript({
      target: { tabId },
      func: () => {
        const nodes = Array.from(document.querySelectorAll<HTMLInputElement>('input, textarea'));
        return nodes.map((el) => ({
          type: (el.getAttribute('type') ?? 'text').toLowerCase(),
          name: el.getAttribute('name') ?? '',
          id: el.id ?? '',
          autocomplete: el.getAttribute('autocomplete') ?? '',
          placeholder: el.getAttribute('placeholder') ?? '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          labelText: el.closest('label')?.textContent?.trim().slice(0, 200) ?? '',
          isVisible: !el.hidden && getComputedStyle(el).display !== 'none',
          isDisabled: el.disabled,
          isReadOnly: el.readOnly,
          value: el.value.length > 0 ? ' ' : '',
        }));
      },
    });
    return (res?.result ?? []) as FieldDescriptor[];
  } catch {
    // 注入失败（比如扩展没有该页面的权限）—— 退回用上报的那份
    return [];
  }
}

/**
 * 表单提交之后：取一次值，判断该不该提示保存。
 *
 * ⚠️ 取值这一步**必须由 background 注入完成**。让 content script 顺手把
 * 值读出来发过来要省事得多，但那样明文就常驻在页面里的那份代码中了 ——
 * 而它正是最容易被打字机/XSS 够到的地方。
 */
async function onSubmitted(tabId: number | undefined, url: string | undefined): Promise<void> {
  const owner = getClient();
  // 这条链路上每一步都可能「合理地」放弃，而每一个放弃都必须是**可诊断的** ——
  // 否则用户那边表现为「提交了但没提示保存」，我们这边什么都看不到。
  if (tabId === undefined || url === undefined) {
    console.debug('[onewarden] 捕获跳过：拿不到标签页或地址');
    return;
  }

  const session = await sessions.load();
  if (!session) {
    console.debug('[onewarden] 捕获跳过：保险库未解锁');
    return;
  }

  const fields = await readFieldsFrom(tabId);
  const plan = classifyFields(fields);
  if (plan.password === undefined) {
    console.debug(`[onewarden] 捕获跳过：页面上没识别出密码框（读到 ${fields.length} 个输入框）`);
    return;
  }

  const indices = plan.username === undefined ? [plan.password] : [plan.username, plan.password];
  const [injection] = await ext.scripting.executeScript({
    target: { tabId },
    func: readFieldValues,
    args: [indices],
  });
  const values = (injection?.result ?? []) as (string | null)[];
  requireCurrentClient(owner);
  if (values.length === 0) {
    console.debug('[onewarden] 捕获跳过：注入读取没有返回结果');
    return;
  }

  const username = plan.username === undefined ? null : values[0] ?? null;
  const password = plan.username === undefined ? values[0] : values[1];
  if (typeof password !== 'string') {
    console.debug('[onewarden] 捕获跳过：读到的密码不是字符串');
    return;
  }
  console.debug(`[onewarden] 捕获到登录信息（用户名 ${username === null ? '空' : '有'}，密码长度 ${password.length}）`);

  const decision = decideCapture({ url, username, password }, session.items);
  if (decision.kind === 'none') {
    // 没变化就清掉上一次的提示 —— 用户可能刚手动改好了
    await setPending(null, tabId, owner);
    await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }

  await setPending({ tabId, url, username, password, decision }, undefined, owner);
  // 角标只提示「有事可做」，不放数字 —— 数字会让人以为是待办事项
  await ext.action.setBadgeText({ tabId, text: '●' }).catch(() => {});
  await ext.action.setBadgeBackgroundColor({ color: '#3E7C8C' }).catch(() => {});
}

/** 站点的显示名：用主机名，与 1Password 的默认命名一致 */
function nameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** 拼一条新的登录条目。`id` 为空串表示新建 */
function newLoginItem(url: string, username: string | null, password: string): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: nameFor(url), nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: {
      username, password, totp: null,
      uris: [{ uri: url, match: null }],
      passwordRevisionDate: null,
      // 新建的条目还没有 passkey —— 用户之后可以在站点上注册一个
      fido2Credentials: [],
    },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

/**
 * 确保离屏文档在跑。
 *
 * 用 `getContexts` 查而不是自己记一个布尔量：service worker 随时会被杀，
 * 模块变量归零，但离屏文档**还活着** —— 靠记忆判断会创建出第二个，
 * 而 `createDocument` 遇到已存在会直接抛错。
 *
 * 同时并发也要挡：两个复制动作挨着来会双双走到创建那一步。
 */
let offscreenReady: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    const contexts = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
    if (contexts.length === 0) {
      await ext.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
        justification: '弹窗关闭后按时清空仍未被覆盖的密码',
      });
    }
  })().finally(() => { offscreenReady = null; });
  return offscreenReady;
}

let clipboardTimer: ReturnType<typeof setTimeout> | null = null;
const firefoxClipboard = createClipboardStore({
  area: sessionArea,
  clipboard: {
    readText: () => navigator.clipboard.readText(),
    writeText: (value) => navigator.clipboard.writeText(value),
  },
  async schedule(deadline) {
    await ext.alarms.create(CLIPBOARD_ALARM, { when: deadline });
    if (clipboardTimer !== null) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => {
      clipboardTimer = null;
      void firefoxClipboard.resume().catch(reportFailure);
    }, Math.max(0, deadline - Date.now()));
  },
});

async function scheduleClipboard(value: string): Promise<void> {
  if (!ext.offscreen || !ext.runtime.getContexts) {
    await firefoxClipboard.schedule(value);
    return;
  }
  await ensureOffscreen();
  await ext.runtime.sendMessage({ type: '1warden-internal:schedule-clear', value, deadline: Date.now() + CLIPBOARD_CLEAR_MS });
}

// Recreate a Firefox event page's timer from its absolute deadline when it wakes up.
if (!ext.offscreen) void firefoxClipboard.resume().catch(reportFailure);

// ── 角标 ──

async function updateBadge(tabId: number, isLoginForm: boolean): Promise<void> {
  const session = await sessions.load();
  await ext.action.setBadgeText({
    tabId,
    text: isLoginForm && session ? '•' : '',
  }).catch(() => {});
}

/**
 * 重新点亮所有「有登录表单」的标签页角标。
 *
 * ⚠️ 必须有这一步。角标原本只在**收到 content script 上报的那一刻**算，
 * 而那一刻通常发生在用户还没解锁的时候 —— 于是解锁之后角标依然是空的，
 * 用户盯着浏览器工具栏看不出这个站点有没有存过密码。
 *
 * 顺带解决了 service worker 被杀的问题：它醒来后 `tabFields` 是空的，
 * 但直接问各标签页拿得到当前状态。
 */
async function refreshBadges(): Promise<void> {
  const owner = getClient();
  const session = await sessions.load();
  const tabs = await ext.tabs.query({});

  await Promise.all(tabs.map(async (t) => {
    if (t.id === undefined) return;
    let isLoginForm = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Edge sleeping/frozen tabs can leave sendMessage pending indefinitely.
      // Decorative badges must never hold up persistence, login or account switching.
      const res = await Promise.race([
        ext.tabs.sendMessage(t.id, { type: '1warden:read-fields' }) as Promise<{ isLoginForm?: boolean } | undefined>,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_500); }),
      ]);
      isLoginForm = res?.isLoginForm === true;
    } catch {
      // 这个标签页没有我们的 content script（chrome:// 之类）—— 正常
      return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (owner !== client || !owner.isUnlocked()) return;
    await ext.action.setBadgeText({
      tabId: t.id, text: session !== null && isLoginForm ? '•' : '',
    }).catch(() => {});
  }));
}

async function clearBadges(): Promise<void> {
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map((t) =>
    t.id === undefined ? Promise.resolve() : ext.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {})));
}

// worker 醒来时把标签页角标补上 —— 被杀期间状态是丢的
ext.tabs.onActivated.addListener(({ tabId }) => {
  const state = tabFields.get(tabId);
  if (state) void updateBadge(tabId, state.isLoginForm);
});

ext.tabs.onRemoved.addListener((tabId) => { tabFields.delete(tabId); });
