/**
 * 安全报告 —— 1Password 的 Watchtower 等价物。
 *
 * ## 为什么全部在客户端算
 *
 * Vaultwarden **完全没有** `/api/reports/*`（源码三处独立验证过）。所以每一类
 * 检查都必须本地实现。这反而是好事：**用户的密码不需要离开设备**。
 *
 * 唯一的例外是「已泄露的密码」—— 那要查 Have I Been Pwned。它的 k-匿名做法
 * 只把密码 SHA-1 的**前 5 个字符**发出去，是本功能能被接受的前提，
 * 因此必须在界面上明示、且默认关闭。
 *
 * ## 结果里绝不含密码
 *
 * 这里返回的每个结构都会流到界面、可能被序列化、可能进日志。所以一律只给
 * **条目 id**，连哈希都不给 —— 一个没加盐的 SHA-1 依然是凭据材料。
 */
import type { VaultItem } from './model';

/** 只统计「活跃」条目 —— 已删除、已归档的不该出现在安全报告里 */
function isLive(i: VaultItem): boolean {
  return i.deletedAt === null && i.archivedAt === null;
}

export interface ReuseGroup {
  itemIds: string[];
  count: number;
}

export interface WeakFinding {
  itemId: string;
  /** 机器可读的原因，界面负责翻译成人话 */
  reason: 'tooShort' | 'common' | 'commonWithSuffix' | 'leetSubstitution' | 'digitsOnly' | 'repeatedChar';
}

export interface ExpiringFinding {
  itemId: string;
  kind: 'card';
  expiresAt: string;
}

export interface BreachFinding {
  itemId: string;
  /** 该密码在已知泄露库里出现过多少次 */
  count: number;
}

/**
 * 重复使用的密码。
 *
 * 只出现一次的密码不算重复 —— 否则报告会把每个正常用户的整库都列一遍，
 * 真正危险的那几条反而淹没了。
 */
export function findReusedPasswords(items: readonly VaultItem[]): ReuseGroup[] {
  const byPassword = new Map<string, string[]>();
  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;
    const list = byPassword.get(pw);
    if (list) list.push(item.id);
    else byPassword.set(pw, [item.id]);
  }

  return [...byPassword.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ itemIds: ids, count: ids.length }))
    // 用得越多的排越前 —— 泄露一条等于泄露一片
    .sort((a, b) => b.count - a.count);
}

/**
 * 常见弱密码的词根。
 *
 * 不求全 —— 求的是把**最典型的那几类**抓住。更大的词表可以之后替换，
 * 接口不变。
 */
const COMMON = new Set([
  'password', 'passwd', 'pass', '123456', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyuiop', 'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou',
  'admin', 'administrator', 'root', 'welcome', 'login', 'guest', 'test',
  'master', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'trustno1', 'starwars', 'whatever', 'michael', 'jennifer', 'changeme',
  'secret', 'shadow', 'ninja', 'azerty', 'zxcvbnm', 'asdfgh',
]);

/** 把常见的字符替换还原：`P@ssw0rd` → `password` */
function deLeet(s: string): string {
  return s.toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b');
}

/** 结尾那一小段数字/符号：`password123!` 的 `123!` */
const SUFFIX = '[0-9!@#$%^&*._-]{0,4}';

/**
 * 「常见词 + 可选短后缀」。
 *
 * 用一条正则而不是「先剥后缀再查表」：`trustno1` 这种词本身就以数字结尾，
 * 先剥后缀会把它削成 `trustno` 而查不到。词表长这样的时候，后缀剥取永远
 * 会有这一类边界。
 */
const COMMON_RE = new RegExp(
  `^(?:${[...COMMON].sort((a, b) => b.length - a.length).join('|')})${SUFFIX}$`,
);

/** 去掉结尾的短数字/符号后缀 */
function stripSuffix(s: string): string {
  return s.replace(/[0-9!@#$%^&*._-]{1,4}$/, '');
}

/**
 * 弱密码。
 *
 * ⚠️ **不能用纯字符类熵来判**。`P@ssw0rd1!` 和 `Password1!` 的字符类熵都不低，
 * 但它们正是最典型的字典密码 —— 前者的 `@`/`0` 只是 `a`/`o` 的伪装。
 * 把这类密码报成「安全」比不报还糟：用户会以为自己已经改好了，然后不再管它。
 *
 * 所以判定顺序是「先还原、再查表」，而不是算熵。
 */
export function findWeakPasswords(items: readonly VaultItem[]): WeakFinding[] {
  const out: WeakFinding[] = [];

  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;

    const lower = pw.toLowerCase();
    if (pw.length < 8) { out.push({ itemId: item.id, reason: 'tooShort' }); continue; }

    if (COMMON_RE.test(lower)) {
      out.push({ itemId: item.id, reason: COMMON.has(lower) ? 'common' : 'commonWithSuffix' });
      continue;
    }

    // ⚠️ 顺序是**先剥后缀、再还原 leet**，反过来不行：
    // `P@ssw0rd1!` 若先还原，结尾的 `1` 和 `!` 都变成 `i`，得到 `passwordii`，
    // 后缀就再也剥不掉了。先剥成 `p@ssw0rd`，再还原，才是 `password`。
    if (COMMON_RE.test(deLeet(stripSuffix(lower)))) {
      out.push({ itemId: item.id, reason: 'leetSubstitution' });
      continue;
    }

    if (/^\d+$/.test(pw)) { out.push({ itemId: item.id, reason: 'digitsOnly' }); continue; }
    if (/^(.)\1+$/.test(pw)) { out.push({ itemId: item.id, reason: 'repeatedChar' }); continue; }
  }

  return out;
}

/**
 * 还在用明文 HTTP 的站点。
 *
 * 只看 `http://` 前缀 —— 没写协议的存值无从判断，报出来只会是噪音。
 */
export function findUnsecuredSites(items: readonly VaultItem[]): VaultItem[] {
  return items.filter((item) =>
    isLive(item) && (item.login?.uris ?? []).some((u) => u.uri.toLowerCase().startsWith('http://')));
}

/** 1Password 的默认阈值：信用卡提前 2 个月提醒 */
const CARD_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * 即将过期的东西。
 *
 * ⚠️ **只有信用卡**。1Password 还会提醒护照、驾照、API 凭据的「过期」，
 * 但 Bitwarden 的 identity 结构里**根本没有有效期字段** —— 那是 1Password
 * 自己的扩展字段。我们无从判断，也不该假装能判断。
 */
export function findExpiring(items: readonly VaultItem[], now: number): ExpiringFinding[] {
  const out: ExpiringFinding[] = [];

  for (const item of items) {
    if (!isLive(item)) continue;
    if (item.type !== 'card' || !item.card) continue;

    const month = Number(item.card.expMonth);
    const year = Number(item.card.expYear);
    // 用户的输入可能是任何东西 —— 解析不了就跳过，不该让整份报告崩掉
    if (!Number.isInteger(month) || !Number.isInteger(year)) continue;
    if (month < 1 || month > 12 || year < 1970 || year > 9999) continue;

    // 卡的有效期到当月**最后一天**。按当月第一天算会让用户提前一个月换卡
    const expiresAt = Date.UTC(year, month, 1) - DAY_MS;
    if (expiresAt - now <= CARD_DAYS * DAY_MS) {
      out.push({ itemId: item.id, kind: 'card', expiresAt: new Date(expiresAt).toISOString() });
    }
  }

  return out;
}

export interface ScoreInput {
  reused: number;
  weak: number;
  breached: number;
  unsecured: number;
  total: number;
}

export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

/**
 * 安全评分。
 *
 * ⚠️ **1Password 从未文档化它的量表、档位或公式** —— 那个四位数的仪表盘
 * 只存在于截图、alt 文本和更新日志里。所以我们**自己定一套并写清楚**，
 * 不假装复刻他们的算法。
 *
 * 本量表以条目总数为基数，按实际危害加权扣分：
 * 已泄露(3) > 弱密码(2) > 重复使用(1) > 明文网站(0.5)。
 */
export function securityScore(input: ScoreInput): { score: number; grade: ScoreGrade } {
  // 空库不该除零 —— 没有条目也就没有问题，给满分
  const total = Math.max(1, input.total);
  const penalty =
    (input.breached * 3 + input.weak * 2 + input.reused * 1 + input.unsecured * 0.5) / total;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * 100)));

  const grade: ScoreGrade = score >= 90 ? 'excellent'
    : score >= 75 ? 'good'
    : score >= 50 ? 'fair'
    : score >= 25 ? 'poor'
    : 'critical';

  return { score, grade };
}

/** SHA-1 十六进制大写。用 WebCrypto —— 三端都有，不必额外引依赖 */
async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 拆成 HIBP 需要的「5 字符前缀 + 其余部分」 */
export async function hibpPrefix(password: string): Promise<{ prefix: string; suffix: string }> {
  const hex = await sha1Hex(password);
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

export interface BreachOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** HIBP 的 k-匿名查询端点 */
export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * 查已泄露的密码。**必须由用户显式开启。**
 *
 * ⚠️ 这是整个应用**唯一**会向第三方发请求的地方（spec 的 S8 要求无第三方遥测）。
 * k-匿名的保证是：只有 SHA-1 哈希的前 5 个字符离开设备，返回的几百条候选
 * 在本地比对。攻击者从中反推不出具体是哪个密码 —— 除非你的密码本身极弱，
 * 而那种密码本来就该被换掉。
 *
 * 网络失败不抛错：少一项报告，好过整页挂掉。
 */
export async function checkBreaches(
  items: readonly VaultItem[],
  opts: BreachOptions = {},
): Promise<BreachFinding[]> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const out: BreachFinding[] = [];

  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;

    try {
      const { prefix, suffix } = await hibpPrefix(pw);
      const res = await doFetch(`${HIBP_RANGE_URL}${prefix}`, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        // 让服务端用固定长度的假条目填充响应，避免从响应大小推断出前缀命中数
        headers: { 'Add-Padding': 'true' },
      });
      if (!res.ok) continue;

      const text = await res.text();
      for (const line of text.split('\n')) {
        const [hashSuffix, countRaw] = line.trim().split(':');
        if (hashSuffix?.toUpperCase() === suffix) {
          out.push({ itemId: item.id, count: Number(countRaw) || 0 });
          break;
        }
      }
    } catch {
      // 网络失败、被用户中断 —— 跳过这一条，其余照常检查
      continue;
    }
  }

  return out;
}

export interface SecurityReport {
  reused: ReuseGroup[];
  weak: WeakFinding[];
  unsecured: VaultItem[];
  expiring: ExpiringFinding[];
  breached: BreachFinding[];
  total: number;
  score: number;
  grade: ScoreGrade;
}

/**
 * 把各项检查汇总成一份报告。
 *
 * `breached` 由调用方决定要不要传 —— HIBP 是网络请求、需要用户开启，
 * 不该由这个纯函数触发。
 */
export function buildReport(
  items: readonly VaultItem[],
  now: number,
  breached: readonly BreachFinding[] = [],
): SecurityReport {
  const live = items.filter(isLive);
  const reused = findReusedPasswords(items);
  const weak = findWeakPasswords(items);
  const unsecured = findUnsecuredSites(items);
  const expiring = findExpiring(items, now);

  const { score, grade } = securityScore({
    // 按**条目**计而不是按组计 —— 一组重复密码里有 5 条，就有 5 条处在风险中
    reused: reused.reduce((n, g) => n + g.count, 0),
    weak: weak.length,
    unsecured: unsecured.length,
    breached: breached.length,
    total: live.length,
  });

  return { reused, weak, unsecured, expiring, breached: [...breached], total: live.length, score, grade };
}
