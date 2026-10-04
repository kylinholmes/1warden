/**
 * Passkey 的匹配与校验 —— 该把哪个站点的凭据交给哪个页面。
 *
 * ## ⚠️ 这里是整个 passkey 功能里最危险的一段
 *
 * 浏览器原生会把 `rpId` 的域校验做掉：页面在 `evil.com` 上根本没法为
 * `github.com` 发起 WebAuthn。但我们接管了 `navigator.credentials` 之后，
 * **那道强制就没了**，得由我们自己做。
 *
 * 做漏了的后果不是「功能不好用」，而是：任何站点都能向我们要一份
 * `github.com` 的断言签名，拿去登录用户的 GitHub。用户全程看不到异常 ——
 * 页面照常登录，只是签名去了别人的服务器。
 *
 * 所以这里的规则一律**宁可不给，不可给错**。
 */
import { parse as parseDomain } from 'tldts';
import type { VaultItem } from './model';
import type { StoredPasskey } from './passkey';

/** 回环地址：只有这几种允许走 http，别的源必须 https */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * 取出规范的源（scheme + host + 非默认端口）。
 *
 * 非 http(s) 返回 null：`file:` 与 `data:` 页面没有「站点」可言，
 * 拿它们去匹配凭据只会制造误给。
 *
 * ⚠️ 端口要保留（不同端口是不同的源），但**默认端口要归一化掉** ——
 * 否则 `https://example.com:443` 会和 clientDataJSON 里的
 * `https://example.com` 对不上，表现为「明明是对的却校验失败」。
 */
export function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.origin;   // URL.origin 已经做过默认端口归一化
}

/**
 * 页面能不能为这个 rpId 用凭据。
 *
 * 规则（WebAuthn §5.1.3）：rpId 必须**等于**页面主机的有效域，或者是它的
 * 可注册域后缀 —— 也就是父域。`login.example.com` 上的页面可以用
 * `example.com` 作为 rpId（这正是子域共享登录态的用法），但反过来不行。
 */
export function isRpIdAllowed(origin: string, rpId: string): boolean {
  const o = originOf(origin);
  if (o === null || rpId.length === 0) return false;

  const u = new URL(o);
  const host = u.hostname.toLowerCase();
  const id = rpId.toLowerCase();

  if (LOOPBACK.has(host)) {
    // 开发环境：http://localhost 是可信源，但 rpId 只能就是它自己
    return id === host;
  }
  if (u.protocol !== 'https:') return false;

  // ⚠️ 必须按「域名边界」比，不能用 includes：
  // `notexample.com`.includes('example.com') 是 true
  if (host !== id && !host.endsWith(`.${id}`)) return false;

  // ⚠️ rpId 不能是公共后缀。允了 `com` 的话，**所有** .com 站点
  // 共用同一个凭据命名空间，等于把域隔离整个取消掉。
  return parseDomain(id, { allowPrivateDomains: true }).domain !== null;
}

export type ClientDataCheck = { ok: true } | { ok: false; reason: string };

/**
 * 检查页面给的 clientDataJSON。
 *
 * 这份数据是**页面自己构造**的，所以它是攻击者可控的输入 —— 我们签的
 * 「authenticatorData || SHA-256(clientDataJSON)」里有一半来自它。
 * 不检查就签，等于让页面指定签名覆盖什么内容。
 */
export function checkClientData(
  clientDataJSON: Uint8Array,
  expectedType: string,
  expectedOrigin: string,
): ClientDataCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    return { ok: false, reason: 'clientDataJSON 不是合法的 JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'clientDataJSON 不是一个对象' };
  }
  const d = parsed as Record<string, unknown>;

  if (d.type !== expectedType) {
    return { ok: false, reason: `仪式类型不符：期望 ${expectedType}，实为 ${String(d.type)}` };
  }
  if (typeof d.challenge !== 'string' || d.challenge.length === 0) {
    return { ok: false, reason: 'challenge 为空' };
  }
  if (d.origin !== expectedOrigin) {
    return { ok: false, reason: `origin 不符：期望 ${expectedOrigin}，实为 ${String(d.origin)}` };
  }
  // 跨源 iframe 里发起的调用 —— 嵌在别人页面里的 frame 不该拿到凭据
  if (d.crossOrigin === true) {
    return { ok: false, reason: '来自跨源 iframe 的请求' };
  }
  return { ok: true };
}

/** 页面在 allowCredentials 里列出的一个凭据 */
export interface AllowEntry {
  id: string;
  type?: string;
}

export interface Candidate {
  item: VaultItem;
  stored: StoredPasskey;
}

/**
 * 挑出这次可以交给页面的凭据。
 *
 * ⚠️ `allowCredentials` 为**空数组**时结果是空集，不是「没有限制」。
 * 规范把空数组当作「显式地谁都不允许」，而 `null` / 缺失才是没有限制 ——
 * 把空数组当成没有限制，会让页面用 `[]` 拿到我们全部的凭据。
 */
export function pickCredentials(
  items: readonly VaultItem[],
  rpId: string,
  allow: readonly AllowEntry[] | null,
): Candidate[] {
  const allowed = allow === null ? null : new Set(allow.map((a) => a.id));
  const out: Candidate[] = [];

  for (const item of items) {
    // 回收站里的条目还带着凭据，但用户已经删了它
    if (item.deletedAt !== null) continue;
    if (!item.login) continue;

    for (const stored of item.login.fido2Credentials) {
      // ⚠️ rpId 必须**完全相等**。凭据属于哪个 RP 是注册时定死的，
      // 不做后缀匹配 —— 那是「页面能不能用这个 rpId」的规则，不是这条。
      if (stored.rpId !== rpId) continue;
      if (allowed !== null && !allowed.has(stored.credentialId)) continue;
      out.push({ item, stored });
    }
  }
  return out;
}

/** rpName 是 RP 自己填的，可能是一整句话 —— 超过这个长度就退回用 rpId */
const MAX_RP_NAME = 100;

/** 列表里显示什么名字。优先 RP 自报的名字，否则用域名。 */
export function relyingPartyOf(c: { rpId: string; rpName?: string | undefined }): string {
  const name = c.rpName;
  if (typeof name === 'string' && name.length > 0 && name.length <= MAX_RP_NAME) return name;
  return c.rpId;
}
