/**
 * 预览用的假 `chrome.*`。
 *
 * ## ⚠️ 为什么必须单独一个模块，而且必须**第一个** import
 *
 * `ext-api.ts` 是在**模块求值时**抓取命名空间的：
 *
 *     export const ext = globalThis.browser ?? globalThis.chrome;
 *
 * 而普通网页里 Chromium **本来就有** `window.chrome`（只有 `loadTimes` /
 * `csi` 那几个，**没有 `tabs`、没有 `runtime`**）。所以如果这个桩在
 * `Popup.tsx` 被 import **之后**才装上，`ext` 抓到的就是那个真的、没用的
 * `window.chrome` —— 桩装了等于没装。
 *
 * 症状极具误导性：弹窗停在「正在载入…」，看起来像「后台没响应」或者
 * 「preview 数据没接上」，而真正的原因是**模块求值顺序**。
 * （我在这上面绕了一轮：先怀疑了错误处理、又怀疑了静态服务器不过 query。）
 *
 * ES module 的 import 是按书写顺序求值的，所以 `main.tsx` 里
 * `import './stub-chrome'` 写在最前面就足够了 —— 不需要动态 import，
 * 也不需要顶层 await。
 *
 * ⚠️ 装完还会**验一遍**自己确实生效了（见文件末尾）。一个默默没装上的桩
 * 比没有桩更糟：它会把「仪器坏了」伪装成「产品坏了」。
 */

const which = new URLSearchParams(location.search).get('state') ?? 'matched';

import { avatarOf, iconDomainOf, searchItems, summaryOf, type VaultItem } from '@coffer/vault';
import type { ItemSummary } from '../src/popup/Popup';

/**
 * ⚠️ 假数据用**真实的展示函数**算出来，不手写字段。
 *
 * 手写过一版：`ItemSummary` 上的 `iconDomain` / `avatarText` / `avatarHue`
 * 是后加的，桩没跟上 —— 于是 `--h` 变成字符串 `"undefined"`，
 * `oklch(.58 .14 undefined)` 非法、背景整个失效，预览里**每个条目都没有图标**。
 * 而那个样子和「产品坏了」长得一模一样，我照着它排查了一轮。
 *
 * 现在形状由 `VaultItem` 保证、字段由和产品同一套函数算 ——
 * 桩和真实数据的脱节在类型上就不成立了。
 */
function loginItem(
  id: string, name: string,
  opts: { username?: string; uri?: string; totp?: boolean; favorite?: boolean; type?: string; rawType?: number } = {},
): VaultItem {
  const type = opts.type ?? 'login';
  return {
    id, type, rawType: opts.rawType ?? 1, name, nameFailed: false,
    notes: null, notesFailed: false, folderId: null,
    favorite: opts.favorite ?? false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: type === 'login' ? {
      username: opts.username ?? null,
      password: 'x', totp: opts.totp ? 'JBSWY3DPEHPK3PXP' : null,
      uris: opts.uri === undefined ? [] : [{ uri: opts.uri, match: null }],
      passwordRevisionDate: null, fido2Credentials: [],
    } : null,
    card: type === 'card' ? {
      cardholderName: opts.username ?? null, brand: 'Visa', number: '4480 0000 0000 0924',
      expMonth: '09', expYear: '2029', code: '123',
    } : null,
    identity: null,
    secureNote: type === 'secureNote' ? { type: 0 } : null,
    sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const ITEMS: VaultItem[] = [
  loginItem('1', 'GitHub', { username: 'me@example.com', uri: 'https://github.com', totp: true, favorite: true }),
  loginItem('2', '公司 GitHub 组织', { username: 'zhang@acme.example', uri: 'https://github.com' }),
  loginItem('3', 'Vaultwarden 自建', { username: 'admin', uri: 'https://vault.example.com', favorite: true }),
  loginItem('4', '招商银行', { username: '6225 **** 1234' }),
  loginItem('5', '一个名字相当长的条目用来验证截断行为', { username: 'someone@very-long-domain.example', totp: true }),
  loginItem('6', 'AWS 生产环境', { username: 'deploy', totp: true }),
  loginItem('7', '家里的路由器', { username: 'root' }),
  loginItem('8', '知乎', { username: '13800138000', uri: 'https://zhihu.com' }),
  // 其它类型 —— 导航上的类型项是由**数据**来的，全都塞 login 就看不出这件事
  loginItem('9', '招商银行 Visa', { type: 'card', rawType: 3, username: 'ZHANG SAN', favorite: true }),
  loginItem('10', '家里 Wi-Fi 密码', { type: 'secureNote', rawType: 2 }),
];

/** 和 `background.ts` 里的 `summarise` 同一套函数 —— 这是它存在的意义 */
function summarise(item: VaultItem): ItemSummary {
  const av = avatarOf(item);
  return {
    id: item.id,
    name: item.name,
    username: item.login?.username ?? null,
    hasPassword: item.login?.password !== null && item.login?.password !== undefined,
    hasTotp: item.login?.totp !== null && item.login?.totp !== undefined,
    uris: (item.login?.uris ?? []).map((u) => u.uri),
    favorite: item.favorite,
    type: item.type,
    summary: summaryOf(item),
    iconDomain: iconDomainOf(item),
    avatarText: av.text,
    avatarHue: av.hue,
  };
}

/** 站点匹配：只按 host 粗判，够撑开界面就行 —— 真实匹配在 background 里 */
const MATCH_IDS = new Set(['1', '2']);

export function stubChrome(): void {
  // `state=locked` 未登录 → 显示连接表单；`state=connect` 是它的别名，
  // 名字更直白（那个状态在弹窗里就是「还没有账户」）
  const unlocked = which !== 'locked' && which !== 'connect';

  const reply = (msg: Record<string, unknown>): unknown => {
    switch (msg.type) {
      case 'coffer:status':
        return {
          unlocked,
          // 未登录时不该有 account —— 真后台也是这么回的，
          // 给一个假的会让图标缓存那一步走进不该走的分支
          ...(unlocked ? { account: { email: 'me@example.com', serverUrl: 'https://vault.example.com' } } : {}),
          itemCount: ITEMS.length,
        };
      case 'coffer:matches':
        return { items: which === 'empty' ? [] : ITEMS.filter((i) => MATCH_IDS.has(i.id)).map(summarise) };
      /*
       * ⚠️ 空 query 是「浏览整个保险库」，不是「搜不到」——
       * 桩也要照这个语义回，否则预览里看到的是产品不会有的样子。
       */
      case 'coffer:search': {
        const q = String(msg.query ?? '').trim();
        if (q === '') return { items: ITEMS.map(summarise) };
        const hit = searchItems(ITEMS, [], q).map((h) => summarise(h.item));
        return { items: hit };
      }
      /*
       * ⚠️ 必须真的回一个值。默认分支回 `{}` 的话，`CopyButton` 拿到的
       * `value` 是 undefined、写进剪贴板的是空串 —— 界面照样会显示「已复制」，
       * 于是这条预览**看起来**通过了，实际什么都没验到。
       */
      case 'coffer:copy':
        return { value: 'preview-fake-secret' };
      case 'coffer:pending':
        return which === 'pending'
          ? { pending: { url: 'https://github.com/session', username: 'me@example.com', action: 'save', itemId: null } }
          : { pending: null };
      default:
        return {};
    }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://github.com/login' }],
    },
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => reply(msg),
    },
  };
}

stubChrome();

/*
 * ⚠️ 验一遍：如果 `ext` 抓到的还是那个真的 `window.chrome`，这里必须**大声**
 * 说出来。不验的话，失败的样子是「正在载入…」，而那个样子指向错误的方向。
 */
const ns = (globalThis as unknown as { chrome?: { runtime?: unknown; tabs?: unknown } }).chrome;
if (!ns?.runtime || !ns?.tabs) {
  throw new Error(
    '[preview] chrome 桩没有生效 —— ext-api 抓到的不是它。' +
      '检查 main.tsx 里 `import \'./stub-chrome\'` 是否排在 import Popup 之前。',
  );
}
