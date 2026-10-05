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
  summaryOf, iconDomainOf, avatarOf, searchItems, buildReport,
  parseImport, detectImportFormat, IMPORT_FORMATS, type ImportFormatId,
  type AccountInfo, type FieldDescriptor, type VaultItem,
  type CaptureDecision,
  totpCode,
} from '@coffer/vault';
import { fromBase64 } from '@coffer/crypto';
import { host } from '@coffer/ui';
import { SessionStore, restrictSessionToTrustedContexts, type StorageArea } from './session-store';
import { extensionSyncCache } from './sync-cache';
import { fillFields, readFieldValues, type FillEntry, type FillOutcome } from './fill';
import { handleWebauthn, type WebauthnPayload } from './webauthn';

/** 会话区：只在内存、浏览器重启即清空 */
const sessionArea: StorageArea = {
  get: (keys) => ext.storage.session.get(keys as string | string[]),
  set: (items) => ext.storage.session.set(items),
  remove: (keys) => ext.storage.session.remove(keys as string | string[]),
  clear: () => ext.storage.session.clear(),
};

const sessions = new SessionStore(sessionArea);

/** 本次模块求值的随机标识 —— 排查用。见 `coffer:webauthn` 的幂等说明 */
const INSTANCE = Math.random().toString(36).slice(2, 6);
console.debug('[coffer] SW 实例 ' + INSTANCE + ' 启动');

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
const TRACE_KEY = 'coffer.trace';

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
      console.warn('[coffer] 追踪写入失败（之后不再报）：', e);
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
    const got = await ext.storage.local.get('coffer.deviceId');
    return typeof got['coffer.deviceId'] === 'string' ? got['coffer.deviceId'] : null;
  },
  async set(id: string): Promise<void> {
    await ext.storage.local.set({ 'coffer.deviceId': id });
  },
  async clear(): Promise<void> {
    await ext.storage.local.remove('coffer.deviceId');
  },
};

let client: VaultClient | null = null;

function newClient(): VaultClient {
  return new VaultClient({
    /*
     * 走宿主。扩展端这一步是直接 `fetch`（有 host permission，不受 CORS 限制），
     * 桌面端走 Rust —— 差异只在这一行，见 `@coffer/ui/host`。
     */
    fetchImpl: host().fetch,
    deviceStore,
    autoLockMs: 15 * 60 * 1000,
    onLock: () => { void sessions.clear(); },
    /*
     * 上次同步的密文缓存 —— 解锁后先拿它把界面填上，再去问服务端。
     * 桌面端早就有，扩展端一直缺（每次解锁都要等一整轮网络）。
     */
    syncCache: extensionSyncCache,
  });
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
  const c = getClient();
  if (c.getSession().getKey() !== null) return c;   // 已经解锁，别动它
  const stored = await sessions.load();
  // ⚠️ 走 `restore()` 而不是只灌会话 —— 它会把传输层（baseUrl + token）
  // 一起接回去。只灌会话的话读操作正常、写操作全部报「连不上服务器」
  if (stored) c.restore(stored);
  return c;
}

/**
 * ⚠️ 恢复必须发生在**用到的那一刻**，而不是模块加载时。
 *
 * 早先这里是一个在模块顶层求值一次的 `ready` promise，然后 `handle()` 里
 * await 它。那个写法有个致命的时间窗：模块可能**在用户解锁之前**就加载完了
 * （SW 被提前唤醒、或者同一份代码在不止一个上下文里跑），于是 `ready` 读到的
 * 是「存储里还没有会话」，之后再也不会重试 —— 用户明明解锁了，
 * 请求却报「保险库未解锁」，而且刷新一下就好、过一会儿又坏。
 *
 * 改成每次用到时先看一眼：已解锁就直接走，没有就去存储里捞。
 * 这是个幂等的检查，比「赌恢复已经完成」可靠得多。
 */
async function unlockedClient(): Promise<VaultClient> {
  try {
    return await restoreFromStorage();
  } catch (e) {
    // 恢复失败当作没登录，让用户重新解锁 —— 但不能静默，否则
    // 「解锁了却用不了」会变成一个查不出原因的幽灵问题
    console.error('[coffer] 恢复会话失败：', e);
    return getClient();
  }
}

function getClient(): VaultClient {
  client ??= newClient();
  return client;
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
const PENDING_KEY = 'coffer.pending';

interface PendingCapture {
  tabId: number;
  url: string;
  username: string | null;
  password: string;
  decision: CaptureDecision;
}

async function setPending(p: PendingCapture | null, tabId?: number): Promise<void> {
  const got = await ext.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  if (p === null) {
    if (tabId !== undefined) delete map[String(tabId)];
  } else {
    map[String(p.tabId)] = p;
  }
  await ext.storage.session.set({ [PENDING_KEY]: map });
}

async function getPending(tabId: number): Promise<PendingCapture | null> {
  const got = await ext.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  return map[String(tabId)] ?? null;
}

type Request =
  | { type: 'coffer:status' }
  | { type: 'coffer:connect'; serverUrl: string; email: string; masterPassword: string }
  | { type: 'coffer:lock' }
  | { type: 'coffer:list' }
  | { type: 'coffer:matches'; url: string }
  | { type: 'coffer:search'; query: string }
  | { type: 'coffer:folders' }
  | { type: 'coffer:security' }
  | { type: 'coffer:item'; itemId: string }
  | { type: 'coffer:import-parse'; dataBase64: string; format?: string }
  | { type: 'coffer:import-commit'; dataBase64: string; format?: string }
  | { type: 'coffer:fill'; itemId: string; tabId: number }
  | { type: 'coffer:generate'; length?: number; digits?: boolean; symbols?: boolean }
  | { type: 'coffer:pending'; tabId?: number }
  | { type: 'coffer:save-capture'; tabId?: number }
  | { type: 'coffer:dismiss-capture'; tabId?: number }
  | { type: 'coffer:reveal'; itemId: string; field: 'username' | 'password' | 'totp' }
  | { type: 'coffer:copy'; itemId: string; field: 'username' | 'password' | 'totp' }
  | { type: 'coffer:webauthn'; payload: unknown };

ext.runtime.onMessage.addListener((msg: unknown, sender, respond) => {
  const req = msg as { type?: string };

  // content script 的字段上报：记下来，顺手回一个空响应
  if (req?.type === 'coffer:fields') {
    const from = sender.tab?.id;
    if (from !== undefined) {
      const m = msg as { url: string; fields: FieldDescriptor[]; isLoginForm: boolean };
      tabFields.set(from, { url: m.url, fields: m.fields, isLoginForm: m.isLoginForm });
      void updateBadge(from, m.isLoginForm);
    }
    return undefined;
  }

  // 表单提交：异步处理，不需要回包
  if (req?.type === 'coffer:submitted') {
    void onSubmitted(sender.tab?.id, (msg as { url?: string }).url)
      // 捕获失败确实不该影响页面，但**必须留下痕迹** —— 静默吞掉的错误
      // 会让「点了保存没反应」变成一个查不出原因的幽灵问题
      .catch((e: unknown) => console.error('[coffer] 捕获失败：', e));
    return undefined;
  }

  if (!req?.type?.startsWith('coffer:')) return undefined;

  void handle(req as Request, sender)
    .then((r) => respond(r))
    .catch((e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
  return true;   // 异步响应
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
const WA_DONE_KEY = 'coffer.webauthnDone';

/** ⚠️ 请求 id 只是页面内的自增计数 —— 不带标签页会跨标签页串号 */
function waKey(sender: chrome.runtime.MessageSender, id: number): string {
  return `${sender.tab?.id ?? -1}:${sender.frameId ?? 0}:${id}`;
}

async function readDone(key: string): Promise<Record<string, unknown> | null> {
  const got = await ext.storage.session.get(WA_DONE_KEY);
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
async function claim(key: string): Promise<boolean> {
  const got = await ext.storage.session.get(WA_CLAIM_KEY);
  const map = (got[WA_CLAIM_KEY] ?? {}) as Record<string, number>;

  // ⚠️ 认领**必须会过期**。持有它的实例可能半路被杀（这正是我们面对的那个
  // 场景），认领会永远留着 —— 后来者干等十秒然后报错，比不做互斥还糟。
  const held = map[key];
  if (held !== undefined && Date.now() - held < CLAIM_TTL_MS) return false;

  // 只留最近几十个，别让这张表无限长
  for (const k of Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - 32))) delete map[k];
  map[key] = Date.now();
  await ext.storage.session.set({ [WA_CLAIM_KEY]: map });

  // ⚠️ 写完要**等一小段随机时间再读回来**。
  //
  // 两个实例可能几乎同时读（都看到没被认领）→ 都写 → 都回读。
  // 如果回读发生得太快，可能在自己写完之后、对方写之前完成，于是两边都以为
  // 自己赢了 —— 互斥形同虚设。加抖动把「写」和「回读」错开，让后来者一定被看见。
  //
  // 这是最后一道保险：实测过没有它时好时坏（同一份代码连着跑两次，
  // 一次全绿一次红），而这种「偶尔丢凭据」的 bug 正是最难被用户说清楚的。
  await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));

  const back = await ext.storage.session.get(WA_CLAIM_KEY);
  const after = (back[WA_CLAIM_KEY] ?? {}) as Record<string, number>;
  // 不是自己写的 → 有人抢先。两个实例同时写时后写的赢，先写的读到不是自己就让位
  return after[key] === map[key];
}

async function releaseClaim(key: string): Promise<void> {
  const got = await ext.storage.session.get(WA_CLAIM_KEY);
  const map = (got[WA_CLAIM_KEY] ?? {}) as Record<string, number>;
  delete map[key];
  await ext.storage.session.set({ [WA_CLAIM_KEY]: map });
}

const WA_CLAIM_KEY = 'coffer.webauthnClaim';

/** 认领的有效期。超过它视为持有者已死，后来者可以接管 */
const CLAIM_TTL_MS = 30_000;

async function writeDone(key: string, reply: Record<string, unknown>): Promise<void> {
  const got = await ext.storage.session.get(WA_DONE_KEY);
  const map = (got[WA_DONE_KEY] ?? {}) as Record<string, Record<string, unknown>>;
  map[key] = reply;
  // 只留最近几十条 —— 页面开一整天的话这个表不该无限长下去
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - 32))) delete map[k];
  await ext.storage.session.set({ [WA_DONE_KEY]: map });
}

async function runWebauthn(payload: unknown, senderOrigin: string | undefined): Promise<Record<string, unknown>> {
  // ⚠️ 只认客户端这一份状态。
  // 原先这里还额外读了 `sessions.load()` 来判断「解锁了没有」，
  // 于是同一个事实有了两个来源 —— 而它们会不一致（存储里没有、
  // 但客户端刚被 connect 解锁过），表现为用户刚解锁却报「保险库未解锁」。
  // 密钥在不在，`getKey()` 说了算。
  const c = await unlockedClient();
  const key = c.getSession().getKey();
  if (!key) return { ok: false, error: `保险库未解锁（${c.getSession().status}）` };

  const result = await handleWebauthn(payload as WebauthnPayload, senderOrigin, {
    items: () => c.getSession().items,
    userKey: () => key,
    refresh: () => c.refresh(),
    isUnlocked: () => c.getSession().isUnlocked(),
    trace,
    persist: async (changed) => {
      for (const item of changed) await c.saveItem(item);
      // 和 save-capture 一样：存完必须刷一次会话快照，
      // 否则下一次读到的还是旧的，第二次断言会拿着过期的计数去存
      if (c.getSession().getKey()) await sessions.save(c.exportState());
    },
  });
  // passkey 失败在页面上只会表现成一句「NotAllowedError」，
  // 看不出是 rpId 被拒、没有可用凭据、还是存不进保险库。
  // 这里是唯一能留下原因的地方。
  if (result['ok'] === false) console.warn('[coffer] passkey 失败：', result['error']);
  return result;
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (req.type) {
    case 'coffer:status': {
      const session = await sessions.load();
      return {
        unlocked: session !== null,
        account: session?.account ?? null,
        itemCount: session?.items.length ?? 0,
      };
    }

    case 'coffer:connect': {
      const c = await unlockedClient();
      await c.connect({
        serverUrl: req.serverUrl, email: req.email, masterPassword: req.masterPassword,
      });
      const session = c.getSession();
      const key = session.getKey();
      if (!key) throw new Error('解锁后拿不到密钥');
      await sessions.save(getClient().exportState());
      // 解锁之后要把角标补上 —— 见 refreshBadges 的说明
      await refreshBadges();
      return { ok: true, itemCount: session.items.length };
    }

    case 'coffer:lock': {
      getClient().lock();
      await sessions.clear();
      await clearBadges();
      return { ok: true };
    }

    case 'coffer:list': {
      const session = await sessions.load();
      if (!session) return { unlocked: false, items: [] };
      return { unlocked: true, account: session.account, items: session.items.map(summarise) };
    }

    case 'coffer:matches': {
      const session = await sessions.load();
      if (!session) return { unlocked: false, items: [] };
      // 匹配跑在这里 —— 只有这里同时握有完整的 uris 与站点地址
      return { unlocked: true, items: matchItemsByUrl(session.items, req.url).map(summarise) };
    }

    /**
     * 搜索 —— **空 query 是「浏览整个保险库」**（收藏优先、然后按最近更新）。
     *
     * ⚠️ 和 `coffer:matches` 同一个理由放在后台：完整条目（含每个网址、
     * 备注、自定义字段）只在后台这一份。把全量条目送去弹窗让它本地搜，
     * 等于为了省一次消息把攻击面扩大一圈 —— 而弹窗是唯一跑在页面旁边、
     * 和其它扩展共处一个进程的上下文。
     *
     * ⚠️ 用 `searchItems` 而不是在这里写个 `filter`：它带打分（精确 > 前缀 >
     * 词首 > 包含 > 次要字段），而且**过滤掉已删除/已归档**的条目。
     * 各写一份的话，「搜到了已删除的密码」这种事迟早会发生。
     */
    /**
     * 文件夹列表 —— 给导航栏用。
     *
     * ⚠️ 和 `coffer:search` 分开而不是塞进每条摘要里：文件夹是**整个库**的
     * 一份（几十个），条目是几百上千条。跟着摘要重复传会让消息大出一个量级，
     * 而它们的变化频率完全不同（改文件夹名不该让整份列表失效）。
     */
    case 'coffer:folders': {
      const session = await sessions.load();
      if (!session) return { unlocked: false, folders: [] };
      return {
        unlocked: true,
        folders: session.folders.map((f) => ({
          id: f.id,
          name: f.nameFailed ? '无法解密' : f.name,
        })),
      };
    }

    /**
     * 安全报告 —— 和桌面端**同一份逻辑**（`@coffer/vault` 的 `buildReport`）。
     *
     * ⚠️ **`unsecured` 必须降级成摘要再回**。报告的其它部分只有 `itemId`
     * （没有条目本体），只有它是 `VaultItem[]`（完整条目、带明文密码）——
     * 直接送回弹窗就破了「弹窗只拿摘要」那条边界，而那条边界正是
     * `coffer:matches` 刻意把匹配放在后台的原因。
     *
     * `breached`（HIBP 查询）**不在这里触发** —— 它是网络请求、需要用户
     * 明确开启，而且是这个应用唯一会联系第三方的功能。默认空。
     */
    /**
     * **单条**条目的详情字段 —— 按需取一条，不是把整库送过去。
     *
     * ⚠️ 列表接口刻意只回摘要（见 `coffer:matches` 的说明），所以摘要里
     * 没有卡片号、身份信息、SSH 密钥这些。详情要显示它们，就得单独取 ——
     * 但取的是**这一条**，而且是用户点开哪条取哪条。
     *
     * ⚠️ **仍然只回展示用的字段，不回明文密码。** 密码照旧只在点「复制」
     * 那一刻由 `coffer:copy` 取一次。详情屏没有理由看到它。
     */
    case 'coffer:item': {
      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');
      const i = session.items.find((x) => x.id === req.itemId);
      if (!i) throw new Error('找不到这条记录');
      return {
        notes: i.notes,
        card: i.card,
        identity: i.identity,
        sshKey: i.sshKey,
        secureNote: i.secureNote,
      };
    }

    /**
     * **导入的第一步：只解析、不上传。**
     *
     * 用户选完文件先看到「会导入多少条、有哪些文件夹」，确认了才真写。
     * 直接写的话，选错文件（比如把一个无关的 csv 拖进来）会让库里多出
     * 一堆垃圾，而删除比导入麻烦得多。
     *
     * ⚠️ 文件走 base64 过消息通道：`parseImport` 要的是 `Uint8Array`，
     * 而扩展的消息通道只保证结构化克隆 —— 直接传 `Uint8Array` 在
     * 某些浏览器上会被转成 `{0:..,1:..}` 那种普通对象。
     */
    case 'coffer:import-parse': {
      const bytes = fromBase64(req.dataBase64);
      const format = detectImportFormat(bytes) ?? (req.format as ImportFormatId | undefined) ?? null;
      if (format === null) {
        throw new Error('认不出这个文件的格式（支持 1PUX / Bitwarden / KeePass / CSV）');
      }
      const parsed = await parseImport(bytes, format);
      return {
        format,
        formatLabel: IMPORT_FORMATS.find((f) => f.id === format)?.label ?? format,
        /* 文件夹只有名字（`ImportResult` 不单独给一份），按名字去重 */
        folders: new Set(parsed.items.map((i) => i.folderName).filter((n) => n !== null)).size,
        items: parsed.items.length,
        /* 被跳过的行也要报 —— 静默丢掉是最容易被当成「导入坏了」的那种 */
        skipped: parsed.skipped.length,
        /* 按类型分一下，让用户在确认前知道「里面有 3 张卡」这种 */
        byType: parsed.items.reduce<Record<string, number>>((m, i) => {
          m[i.type] = (m[i.type] ?? 0) + 1;
          return m;
        }, {}),
      };
    }

    /**
     * **导入的第二步：真写入。**
     *
     * 重新解析一遍（不用把条目从界面传回来）—— 解析是确定性的，而让界面
     * 持有几百条明文再传回来，等于把整份数据多过一道手。
     *
     * `importItems` 自己负责建文件夹、按名字复用、逐条报失败（见那边的说明）。
     * 这里只把它跑起来并把结果原样带回。
     */
    case 'coffer:import-commit': {
      const c = await unlockedClient();
      const bytes = fromBase64(req.dataBase64);
      const format = detectImportFormat(bytes) ?? (req.format as ImportFormatId | undefined) ?? null;
      if (format === null) throw new Error('认不出这个文件的格式');
      const parsed = await parseImport(bytes, format);
      const result = await c.importItems(parsed.items);
      return result;
    }

    case 'coffer:security': {
      const session = await sessions.load();
      if (!session) return { unlocked: false, report: null };
      const r = buildReport(session.items, Date.now());
      return {
        unlocked: true,
        report: {
          total: r.total,
          score: r.score,
          grade: r.grade,
          // 绝大多数发现本来就只有 `itemId`（没有条目本体）—— 原样回
          reused: r.reused,
          weak: r.weak,
          expiring: r.expiring,
          // ⚠️ 只有 `unsecured` 是 `VaultItem[]`（完整条目、带明文密码）。
          // 它是这里**唯一**需要降级成摘要的东西 —— 直接回就破了
          // 「弹窗拿不到完整条目」那条边界。
          unsecured: r.unsecured.map((i) => ({
            id: i.id, name: i.nameFailed ? '无法解密' : i.name,
          })),
        },
      };
    }

    case 'coffer:search': {
      const session = await sessions.load();
      if (!session) return { unlocked: false, items: [] };
      return {
        unlocked: true,
        items: searchItems(session.items, session.folders, req.query).map((h) => summarise(h.item)),
      };
    }

    case 'coffer:fill': {
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
      if (entries.length === 0) throw new Error('这个页面上找不到可以填的字段');

      const [injection] = await ext.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: fillFields,
        args: [entries],
      });

      const outcomes = (injection?.result ?? []) as FillOutcome[];
      const failed = outcomes.filter((o) => !o.ok || !o.verified);
      return { ok: failed.length === 0, outcomes, failed };
    }

    case 'coffer:generate': {
      const { generatePassword } = await import('@coffer/crypto');
      return {
        password: generatePassword({
          length: req.length ?? 20,
          ...(req.digits === undefined ? {} : { digits: req.digits }),
          ...(req.symbols === undefined ? {} : { symbols: req.symbols }),
        }),
      };
    }

    case 'coffer:pending': {
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

    case 'coffer:save-capture': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) throw new Error('找不到标签页');
      const p = await getPending(tabId);
      if (p === null) throw new Error('没有待保存的登录信息');

      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');

      const c = await unlockedClient();
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
      if (c.getSession().getKey()) await sessions.save(c.exportState());

      await setPending(null, tabId);
      await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      return { ok: true };
    }

    /**
     * 取出一个字段的明文，供弹窗复制。
     *
     * ⚠️ 这是**唯一**会把明文交给弹窗的接口，而且只在用户明确点了「复制」时调用。
     * 列表接口刻意只回摘要 —— 弹窗平时没有任何理由看到密码。
     *
     * `totp` 是算出来的而不是存下来的：种子存在条目里，验证码每次现算。
     */
    /**
     * passkey。
     *
     * ⚠️ `sender.origin` 是这里唯一的信任根 —— 消息的载荷全部由页面控制，
     * 包括它自称的 origin。用载荷里的 origin 去做 rpId 校验，等于没有校验。
     */
    case 'coffer:webauthn': {
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
      if (typeof reqId !== 'number') return await runWebauthn(req.payload, sender.origin);

      const key = waKey(sender, reqId);

      const done = await readDone(key);
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
      if (!(await claim(key))) {
        // 抢不到就等对方 —— 不自己也跑一遍
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const r = await readDone(key);
          if (r) return r;
        }
        return { ok: false, error: '另一个 passkey 请求还在处理中，请重试' };
      }

      const result = await runWebauthn(req.payload, sender.origin);
      // ⚠️ 失败**不**记缓存：让页面能重试。成功的才记 ——
      // 而成功的结果不记的话，SW 重启后同一个请求会再跑一遍并覆盖。
      if (result['ok'] === true) await writeDone(key, result);
      else await releaseClaim(key);
      return result;
    }

    case 'coffer:reveal': {
      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');

      const item = session.items.find((i) => i.id === req.itemId);
      if (!item?.login) throw new Error('这条记录没有可复制的登录信息');

      switch (req.field) {
        case 'username':
          if (item.login.username === null) throw new Error('这条记录没有用户名');
          return { value: item.login.username };
        case 'password':
          if (item.login.password === null) throw new Error('这条记录没有密码');
          return { value: item.login.password };
        case 'totp': {
          const code = await totpCode(item);
          if (code === null) throw new Error('这条记录没有验证码，或密钥不合法');
          return { value: code.code, remaining: code.remaining };
        }
        default:
          throw new Error(`未知字段：${String(req.field)}`);
      }
    }

    /**
     * 复制到剪贴板。
     *
     * ⚠️ 明文**不经过弹窗**：这里取出来直接交给离屏文档，弹窗只拿到
     * 「复制好了没有」。而且清理定时器跑在离屏文档里 ——
     * 弹窗关掉之后它还在，这正是「复制完忘了」那种情况所需要的。
     */
    case 'coffer:copy': {
      const session = await sessions.load();
      if (!session) throw new Error('保险库未解锁');
      const item = session.items.find((i) => i.id === req.itemId);
      if (!item?.login) throw new Error('这条记录没有可复制的登录信息');

      let value: string;
      switch (req.field) {
        case 'username':
          if (item.login.username === null) throw new Error('这条记录没有用户名');
          value = item.login.username;
          break;
        case 'password':
          if (item.login.password === null) throw new Error('这条记录没有密码');
          value = item.login.password;
          break;
        case 'totp': {
          const code = await totpCode(item);
          if (code === null) throw new Error('这条记录没有验证码，或密钥不合法');
          value = code.code;
          break;
        }
        default:
          throw new Error(`未知字段：${String(req.field)}`);
      }

      // 让离屏文档把清理定时器挂上。**发完不管** —— 它的应答回不来
      // （见 offscreen.ts 顶部）。清理失败不影响这次复制本身。
      void ensureOffscreen()
        .then(() => ext.runtime.sendMessage({
          type: 'coffer-internal:schedule-clear', value,
        }))
        .catch((e: unknown) => console.warn('[coffer] 剪贴板清理未能安排：', e));

      // 值交回弹窗由它写剪贴板：弹窗有用户手势，而且写失败时它当场就知道，
      // 可以如实告诉用户 —— 换成这里写就没人能报错了
      return { value, clearAfterSeconds: 30 };
    }

    case 'coffer:dismiss-capture': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { ok: true };
      await setPending(null, tabId);
      await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      return { ok: true };
    }

    default: {
      // 走到这里说明 Request 加了新成员却没加 case。上面的 switch 是穷尽的，
      // 所以 TypeScript 把 req 收窄成了 never —— 正是我们想要的提醒
      const unknown = req as { type: string };
      throw new Error(`未知请求：${unknown.type}`);
    }
  }
}

/**
 * 列表用的摘要。
 *
 * ⚠️ **不含密码与验证码** —— 明文留在 background，弹窗要填充时再让
 * background 自己去取。少送出去一次就少一分风险，弹窗里也没有任何理由
 * 需要看到它们。
 */
function summarise(i: VaultItem) {
  return {
    id: i.id,
    name: i.nameFailed ? '无法解密' : i.name,
    username: i.login?.username ?? null,
    hasPassword: i.login?.password != null,
    // 只报「有没有」，不报种子本身
    hasTotp: i.login?.totp != null,
    uris: i.login?.uris.map((u) => u.uri) ?? [],
    favorite: i.favorite,
    /*
     * 文件夹 —— 扩展端要和桌面端**对齐**（用户明确要求：这些逻辑两边都要有）。
     * 只是个 id，不带名字：名字在 `coffer:folders` 那条消息里单独给，
     * 因为它是**整个库**的一份，跟着每条摘要重复几十遍没道理。
     */
    folderId: i.folderId,
    // 显示用的三个 —— 见 Popup.tsx 里 ItemSummary 的说明
    type: i.type,
    summary: summaryOf(i),
    iconDomain: iconDomainOf(i),
    ...(() => { const a = avatarOf(i); return { avatarText: a.text, avatarHue: a.hue }; })(),
  };
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
  // 这条链路上每一步都可能「合理地」放弃，而每一个放弃都必须是**可诊断的** ——
  // 否则用户那边表现为「提交了但没提示保存」，我们这边什么都看不到。
  if (tabId === undefined || url === undefined) {
    console.debug('[coffer] 捕获跳过：拿不到标签页或地址');
    return;
  }

  const session = await sessions.load();
  if (!session) {
    console.debug('[coffer] 捕获跳过：保险库未解锁');
    return;
  }

  const fields = await readFieldsFrom(tabId);
  const plan = classifyFields(fields);
  if (plan.password === undefined) {
    console.debug(`[coffer] 捕获跳过：页面上没识别出密码框（读到 ${fields.length} 个输入框）`);
    return;
  }

  const indices = plan.username === undefined ? [plan.password] : [plan.username, plan.password];
  const [injection] = await ext.scripting.executeScript({
    target: { tabId },
    func: readFieldValues,
    args: [indices],
  });
  const values = (injection?.result ?? []) as (string | null)[];
  if (values.length === 0) {
    console.debug('[coffer] 捕获跳过：注入读取没有返回结果');
    return;
  }

  const username = plan.username === undefined ? null : values[0] ?? null;
  const password = plan.username === undefined ? values[0] : values[1];
  if (typeof password !== 'string') {
    console.debug('[coffer] 捕获跳过：读到的密码不是字符串');
    return;
  }
  console.debug(`[coffer] 捕获到登录信息（用户名 ${username === null ? '空' : '有'}，密码长度 ${password.length}）`);

  const decision = decideCapture({ url, username, password }, session.items);
  if (decision.kind === 'none') {
    // 没变化就清掉上一次的提示 —— 用户可能刚手动改好了
    await setPending(null, tabId);
    await ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }

  await setPending({ tabId, url, username, password, decision });
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
    /*
     * ⚠️ **Firefox 系没有 offscreen API。**
     *
     * 没有它 = 复制密码之后**没有地方活一个「30 秒后清空剪贴板」的定时器**。
     * 直接调会抛 `Cannot read properties of undefined`，而那会让
     * **整个复制流程失败** —— 一个「清理得不及时」的问题升级成「复制用不了」。
     *
     * 所以这里降级：复制照常，只是不安排自动清理。
     * 用户拿到的密码仍在剪贴板里，直到他自己覆盖 —— 和大多数密码管理器
     * 在没有 offscreen 时的行为一致。
     *
     * ⚠️ 这是**已知的缺口**，不是解。真正的解要么用 `alarms`（最小 30 秒，
     * 正好），要么改成「下次唤醒时清理」。两条都要改行为，得单独决定。
     */
    if (!ext.offscreen || !ext.runtime.getContexts) {
      console.warn('[offscreen] 这个浏览器没有 offscreen API —— 复制可用，但不会自动清空剪贴板');
      return;
    }
    const contexts = await ext.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    if (contexts.length === 0) {
      await ext.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
        justification: '复制密码后需要在弹窗关闭的情况下也能按时清空剪贴板',
      });
    }

    // 不等它应答 —— 离屏文档的 sendResponse 到不了调用方（见 offscreen.ts 顶部）。
    // 给一小段时间让它的脚本跑起来注册好监听器即可。
    await new Promise((r) => setTimeout(r, 200));
  })().catch((e: unknown) => {
    offscreenReady = null;   // 失败就允许下次重试
    throw e;
  });
  return offscreenReady;
}

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
  const session = await sessions.load();
  const tabs = await ext.tabs.query({});

  await Promise.all(tabs.map(async (t) => {
    if (t.id === undefined) return;
    let isLoginForm = false;
    try {
      const res = await ext.tabs.sendMessage(t.id, { type: 'coffer:read-fields' }) as
        { isLoginForm?: boolean } | undefined;
      isLoginForm = res?.isLoginForm === true;
    } catch {
      // 这个标签页没有我们的 content script（chrome:// 之类）—— 正常
      return;
    }
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
