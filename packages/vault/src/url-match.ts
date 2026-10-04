/**
 * URL 匹配 —— 自动填充该在哪个站点上填哪条凭据。
 *
 * ⚠️ **这是整个应用里最危险的一段判断逻辑。**
 *
 * 填错站点的后果是把密码交给攻击者，而且用户完全察觉不到 —— 页面照常登录，
 * 只是凭据去了别人的服务器。所以这里的每一条规则都**宁可不填，不可填错**：
 * 拿不准就返回 false，让用户自己在列表里选。
 *
 * 与 Bitwarden 的 `UriMatchType` 对齐（见 docs/reference/bitwarden-api-notes.md）：
 *
 *   null = 默认（Domain） · 0 = Domain · 1 = Host · 2 = StartsWith
 *   3 = Exact · 4 = RegularExpression · 5 = Never
 */
import { parse as parseDomain } from 'tldts';
import type { LoginUri, VaultItem } from './model';

export const URI_MATCH = {
  /** 基础域名相同即可 —— `www.example.com` 与 `login.example.com` 都算 */
  domain: 0,
  /** 主机名必须一字不差（含非默认端口） */
  host: 1,
  /** 页面 URL 以存的值开头 */
  startsWith: 2,
  /** 完整 URL 相同 */
  exact: 3,
  /** 存的值是一条正则 */
  regex: 4,
  /** 用户显式排除 —— **永不**填充 */
  never: 5,
} as const;

/**
 * 取出可比较的 Web URL。
 *
 * 只认 http/https：`androidapp://…` 这类在浏览器里没有对应站点，
 * 拿它去匹配网页只会制造误填。存的值没写协议时按 https 补 —— 用户
 * 手填 `example.com` 是常态。
 */
function parseWebUrl(raw: string, assumeScheme: boolean): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const proto = url.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  // 没写协议的存值只在需要时补；页面 URL 没协议说明它本来就不是个网页
  if (!assumeScheme && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  return url;
}

/** 主机名 + 非默认端口。默认端口会被 URL 规范化掉，所以 :443 不会造成差异 */
function hostKeyOf(url: URL): string {
  return url.host.toLowerCase();
}

/**
 * 可注册域名（eTLD+1）。IP 地址没有域名，退回主机名本身。
 *
 * ⚠️ `allowPrivateDomains` 必须开：否则 `alice.github.io` 与 `bob.github.io`
 * 会被当成同一个「基础域名」—— 那是两个不同的人，共用一份凭据就是泄露。
 * 同理，朴素的「取最后两段」在 `com.cn`、`co.uk` 上都是错的。
 */
function registrableDomainOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  return (parsed.domain ?? host).toLowerCase();
}

/** 去掉末尾斜杠，便于比较 —— `https://a.com` 与 `https://a.com/` 是同一个地址 */
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * 条目里存的一个 URI 是否匹配当前页面。
 *
 * @param entry  条目里的 `uris[]` 元素
 * @param pageUrl 浏览器地址栏里的 URL
 */
export function matchesUrl(entry: LoginUri, pageUrl: string): boolean {
  const type = entry.match ?? URI_MATCH.domain;
  if (type === URI_MATCH.never) return false;
  if (typeof entry.uri !== 'string' || entry.uri.trim().length === 0) return false;

  const page = parseWebUrl(pageUrl, false);
  if (page === null) return false;

  // ⚠️ https 的凭据绝不填进 http 页面。
  //
  // 反过来（http 存的填进 https）无害；但这一条会让密码以明文走网络，
  // 中间人直接拿到。攻击者只要能把 https 降级成 http 就能收割密码，
  // 而用户看到的只是一个「没上锁」的图标 —— 不会察觉。
  //
  // 只收紧、不放松：http 存的凭据在 http 页面上照常匹配，不受影响。
  if (type !== URI_MATCH.regex && type !== URI_MATCH.startsWith) {
    const stored = parseWebUrl(entry.uri, true);
    if (stored?.protocol === 'https:' && page.protocol === 'http:') return false;
  }

  switch (type) {
    case URI_MATCH.host: {
      const stored = parseWebUrl(entry.uri, true);
      return stored !== null && hostKeyOf(stored) === hostKeyOf(page);
    }

    case URI_MATCH.domain: {
      const stored = parseWebUrl(entry.uri, true);
      return stored !== null && registrableDomainOf(stored) === registrableDomainOf(page);
    }

    case URI_MATCH.startsWith: {
      const stored = parseWebUrl(entry.uri, true);
      if (stored === null) return false;
      return stripTrailingSlash(page.href).toLowerCase()
        .startsWith(stripTrailingSlash(stored.href).toLowerCase());
    }

    case URI_MATCH.exact: {
      const stored = parseWebUrl(entry.uri, true);
      if (stored === null) return false;
      // origin 含协议、主机与端口 —— Exact 是「完整 URL 相同」，协议当然要一致
      if (stored.origin !== page.origin) return false;
      // 路径大小写敏感，所以单独比
      return stripTrailingSlash(stored.href.slice(stored.origin.length))
        === stripTrailingSlash(page.href.slice(page.origin.length));
    }

    case URI_MATCH.regex: {
      try {
        return new RegExp(entry.uri).test(pageUrl);
      } catch {
        // 用户写错正则：当作不匹配，绝不让它把整个流程炸掉
        return false;
      }
    }

    default:
      // 服务端可能给出我们不认识的类型 —— 保守处理，不匹配
      return false;
  }
}

/** 已删除与已归档的条目不参与自动填充 —— 用户已经把它们收起来了 */
function isFillable(item: VaultItem): boolean {
  return item.deletedAt === null && item.archivedAt === null;
}

/**
 * 当前页面上该出现哪些条目。
 *
 * 保持输入顺序 —— 调用方（popup）按这个顺序展示，顺序稳定用户才能靠位置记忆。
 */
export function matchItemsByUrl(items: readonly VaultItem[], pageUrl: string): VaultItem[] {
  if (parseWebUrl(pageUrl, false) === null) return [];

  const out: VaultItem[] = [];
  for (const item of items) {
    if (!isFillable(item)) continue;
    const uris = item.login?.uris ?? [];
    // 没有网址的条目**不参与自动匹配**：无从判断它属于哪个站点，
    // 全匹配等于把密码送到每一个页面上
    if (uris.length === 0) continue;
    if (uris.some((u) => matchesUrl(u, pageUrl))) out.push(item);
  }
  return out;
}
