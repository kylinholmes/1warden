/**
 * MV3 service worker —— 扩展的大脑。
 *
 * ## 职责
 *
 * - 持有解锁会话（`chrome.storage.session`，见 session-store.ts）
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
import {
  VaultClient, classifyFields, matchItemsByUrl, decideCapture,
  type AccountInfo, type FieldDescriptor, type VaultItem,
  type CaptureDecision,
  totpCode,
} from '@coffer/vault';
import { SessionStore, type StorageArea } from './session-store';
import { fillFields, readFieldValues, type FillEntry, type FillOutcome } from './fill';

/** 会话区：只在内存、浏览器重启即清空 */
const sessionArea: StorageArea = {
  get: (keys) => chrome.storage.session.get(keys as string | string[]),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys as string | string[]),
  clear: () => chrome.storage.session.clear(),
};

const sessions = new SessionStore(sessionArea);

/**
 * 再上一道锁：让 content script 读不到会话区。
 *
 * 默认值就是 `TRUSTED_CONTEXTS`，这里显式写出来 —— 这是一个**安全属性**，
 * 不该依赖某个 API 的默认值不被人改。将来若有人为了别的功能调宽它，
 * 至少得先删掉这行、看见这段注释。
 */
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {
  // 老版本 Chrome 没有这个方法；默认值本来就是安全的，忽略
});

/** 设备标识不是秘密，落盘无妨；但也不能每次启动都换（会在设备列表里堆一堆） */
const deviceStore = {
  async get(): Promise<string | null> {
    const got = await chrome.storage.local.get('coffer.deviceId');
    return typeof got['coffer.deviceId'] === 'string' ? got['coffer.deviceId'] : null;
  },
  async set(id: string): Promise<void> {
    await chrome.storage.local.set({ 'coffer.deviceId': id });
  },
  async clear(): Promise<void> {
    await chrome.storage.local.remove('coffer.deviceId');
  },
};

let client: VaultClient | null = null;

function newClient(): VaultClient {
  return new VaultClient({
    // 扩展有 host permission，直接 fetch 就行
    fetchImpl: (...args) => fetch(...args),
    deviceStore,
    autoLockMs: 15 * 60 * 1000,
    onLock: () => { void sessions.clear(); },
  });
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
  const got = await chrome.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  if (p === null) {
    if (tabId !== undefined) delete map[String(tabId)];
  } else {
    map[String(p.tabId)] = p;
  }
  await chrome.storage.session.set({ [PENDING_KEY]: map });
}

async function getPending(tabId: number): Promise<PendingCapture | null> {
  const got = await chrome.storage.session.get(PENDING_KEY);
  const map = (got[PENDING_KEY] ?? {}) as Record<string, PendingCapture>;
  return map[String(tabId)] ?? null;
}

type Request =
  | { type: 'coffer:status' }
  | { type: 'coffer:connect'; serverUrl: string; email: string; masterPassword: string }
  | { type: 'coffer:lock' }
  | { type: 'coffer:list' }
  | { type: 'coffer:matches'; url: string }
  | { type: 'coffer:fill'; itemId: string; tabId: number }
  | { type: 'coffer:generate'; length?: number; digits?: boolean; symbols?: boolean }
  | { type: 'coffer:pending'; tabId?: number }
  | { type: 'coffer:save-capture'; tabId?: number }
  | { type: 'coffer:dismiss-capture'; tabId?: number };

chrome.runtime.onMessage.addListener((msg: unknown, sender, respond) => {
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
      const c = getClient();
      await c.connect({
        serverUrl: req.serverUrl, email: req.email, masterPassword: req.masterPassword,
      });
      const session = c.getSession();
      const key = session.getKey();
      if (!key) throw new Error('解锁后拿不到密钥');
      await sessions.save({
        account: session.account as AccountInfo,
        userKey: key,
        items: session.items.slice(),
        folders: session.folders.slice(),
      });
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

      const [injection] = await chrome.scripting.executeScript({
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

      const c = getClient();
      const decision = p.decision;
      if (decision.kind === 'update') {
        const existing = session.items.find((i) => i.id === decision.itemId);
        if (!existing) throw new Error('要更新的条目已经不存在了');
        await c.saveItem({
          ...existing,
          login: {
            ...(existing.login ?? { totp: null, uris: [], passwordRevisionDate: null }),
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
      const s2 = c.getSession();
      const key = s2.getKey();
      if (key) {
        await sessions.save({
          account: s2.account as AccountInfo,
          userKey: key,
          items: s2.items.slice(),
          folders: s2.folders.slice(),
        });
      }

      await setPending(null, tabId);
      await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      return { ok: true };
    }

    case 'coffer:dismiss-capture': {
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { ok: true };
      await setPending(null, tabId);
      await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
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
    uris: i.login?.uris.map((u) => u.uri) ?? [],
    favorite: i.favorite,
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
    const [res] = await chrome.scripting.executeScript({
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
  const [injection] = await chrome.scripting.executeScript({
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
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }

  await setPending({ tabId, url, username, password, decision });
  // 角标只提示「有事可做」，不放数字 —— 数字会让人以为是待办事项
  await chrome.action.setBadgeText({ tabId, text: '●' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#3E7C8C' }).catch(() => {});
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
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: {
      username, password, totp: null,
      uris: [{ uri: url, match: null }],
      passwordRevisionDate: null,
    },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

// ── 角标 ──

async function updateBadge(tabId: number, isLoginForm: boolean): Promise<void> {
  const session = await sessions.load();
  await chrome.action.setBadgeText({
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
  const tabs = await chrome.tabs.query({});

  await Promise.all(tabs.map(async (t) => {
    if (t.id === undefined) return;
    let isLoginForm = false;
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: 'coffer:read-fields' }) as
        { isLoginForm?: boolean } | undefined;
      isLoginForm = res?.isLoginForm === true;
    } catch {
      // 这个标签页没有我们的 content script（chrome:// 之类）—— 正常
      return;
    }
    await chrome.action.setBadgeText({
      tabId: t.id, text: session !== null && isLoginForm ? '•' : '',
    }).catch(() => {});
  }));
}

async function clearBadges(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) =>
    t.id === undefined ? Promise.resolve() : chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {})));
}

// worker 醒来时把标签页角标补上 —— 被杀期间状态是丢的
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const state = tabFields.get(tabId);
  if (state) void updateBadge(tabId, state.isLoginForm);
});

chrome.tabs.onRemoved.addListener((tabId) => { tabFields.delete(tabId); });
