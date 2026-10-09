import type { VaultItem, VaultFolder } from './model';

export interface SearchHit { item: VaultItem; score: number }

/** 分数越高越靠前：精确 > 前缀 > 词首 > 包含 > 次要字段 */
const SCORE = {
  nameExact: 1000,
  namePrefix: 800,
  nameWord: 600,
  nameContains: 400,
  username: 300,
  uri: 200,
  folder: 150,
  notes: 100,
  field: 100,
} as const;

/** 只有活跃条目参与搜索与自动填充 */
function isLive(item: VaultItem): boolean {
  return item.deletedAt === null && item.archivedAt === null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreOf(item: VaultItem, folderName: string | null, q: string): number {
  const name = item.name.toLowerCase();
  let best = 0;

  if (name === q) best = SCORE.nameExact;
  else if (name.startsWith(q)) best = SCORE.namePrefix;
  else if (new RegExp(`(^|[\\s\\-_/])${escapeRegex(q)}`).test(name)) best = SCORE.nameWord;
  else if (name.includes(q)) best = SCORE.nameContains;

  if (best === SCORE.nameExact) return best; // 已经是最高分，不必再查

  if (item.login?.username?.toLowerCase().includes(q)) best = Math.max(best, SCORE.username);
  // Names and institutions are useful search terms; never index account numbers,
  // PINs, identity numbers or birth dates in the ordinary search projection.
  const nativeLabels = [item.bankAccount?.bankName, item.bankAccount?.nameOnAccount,
    item.driversLicense?.firstName, item.driversLicense?.middleName, item.driversLicense?.lastName,
    item.passport?.givenName, item.passport?.surname];
  if (nativeLabels.some((value) => value?.toLowerCase().includes(q))) best = Math.max(best, SCORE.username);
  for (const u of item.login?.uris ?? []) {
    if (u.uri.toLowerCase().includes(q)) { best = Math.max(best, SCORE.uri); break; }
  }
  if (folderName?.toLowerCase().includes(q)) best = Math.max(best, SCORE.folder);
  if (item.notes?.toLowerCase().includes(q)) best = Math.max(best, SCORE.notes);
  for (const f of item.customFields) {
    if (f.name.toLowerCase().includes(q) || f.value.toLowerCase().includes(q)) {
      best = Math.max(best, SCORE.field);
      break;
    }
  }
  return best;
}

/**
 * 本地搜索。
 *
 * ⚠️ **绝不返回已删除或已归档的条目** —— 服务端不帮我们过滤。
 * `session.items` 已经只含活跃条目，但这里再防一层，
 * 避免调用方从别处传进全量列表时把已删除的密码搜出来。
 */
export function searchItems(
  items: readonly VaultItem[],
  folders: readonly VaultFolder[],
  query: string,
  opts: { limit?: number } = {},
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const live = items.filter(isLive);

  if (q.length === 0) {
    // 浏览模式：收藏优先，然后按最近更新
    const hits = live.map((item) => ({ item, score: 0 }));
    hits.sort((a, b) =>
      Number(b.item.favorite) - Number(a.item.favorite)
      || b.item.updatedAt.localeCompare(a.item.updatedAt));
    return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
  }

  const folderNames = new Map(folders.map((f) => [f.id, f.name]));
  const hits: SearchHit[] = [];
  for (const item of live) {
    const score = scoreOf(item, item.folderId ? folderNames.get(item.folderId) ?? null : null, q);
    if (score > 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
}

/** 取 URI 的 host，失败返回 null（用户的网址字段可能是任何东西，不能抛错） */
function hostOf(uri: string): string | null {
  try {
    const u = new URL(uri.includes('://') ? uri : `https://${uri}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 按域名匹配条目 —— 给自动填充用。
 *
 * ⚠️ `match === 5`（Never）的条目**永不**参与匹配：那是用户显式设置的意图，
 * 忽略它等于违背用户的安全选择。
 *
 * 其余策略（Domain/Host/StartsWith/Exact/Regex）的完整实现属于浏览器扩展，
 * 这里只做保守的 host 精确匹配 —— 宁可漏填让用户手动选，也不要填错站点。
 */
export function matchByDomain(items: readonly VaultItem[], url: string): VaultItem[] {
  const host = hostOf(url);
  if (host === null) return [];

  const out: VaultItem[] = [];
  for (const item of items) {
    if (!isLive(item)) continue;
    for (const u of item.login?.uris ?? []) {
      if (u.match === 5) continue;
      if (hostOf(u.uri) === host) { out.push(item); break; }
    }
  }
  return out;
}
