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
  VaultClient, classifyFields, matchItemsByUrl,
  type AccountInfo, type FieldDescriptor, type VaultItem,
} from '@coffer/vault';
import { SessionStore, type StorageArea } from './session-store';
import { fillFields, type FillEntry, type FillOutcome } from './fill';

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

type Request =
  | { type: 'coffer:status' }
  | { type: 'coffer:connect'; serverUrl: string; email: string; masterPassword: string }
  | { type: 'coffer:lock' }
  | { type: 'coffer:list' }
  | { type: 'coffer:matches'; url: string }
  | { type: 'coffer:fill'; itemId: string; tabId: number }
  | { type: 'coffer:generate'; length?: number; digits?: boolean; symbols?: boolean };

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
      const entries = buildEntries(plan, item.login);
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
function buildEntries(
  plan: ReturnType<typeof classifyFields>,
  login: { username: string | null; password: string | null; totp: string | null },
): FillEntry[] {
  const entries: FillEntry[] = [];
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
  // ⚠️ 验证码不在填充时生成：它 30 秒就过期，填一个算出来的值只会让
  // 用户在提交时看到「验证码错误」。留给 popup 的「复制验证码」。
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

// ── 角标 ──

async function updateBadge(tabId: number, isLoginForm: boolean): Promise<void> {
  const session = await sessions.load();
  await chrome.action.setBadgeText({
    tabId,
    text: isLoginForm && session ? '•' : '',
  }).catch(() => {});
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
