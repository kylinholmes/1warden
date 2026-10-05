/**
 * 站点图标 —— 从 Vaultwarden 取真实 favicon，取不到就让调用方回退到彩色徽标。
 *
 * ## 这个接口有两个陷阱
 *
 * ### 一、没有图标时它**不回 404**
 *
 * 它回 **HTTP 200 + 一张灰色的地球占位图**。状态码判断不了「到底有没有图标」，
 * 照单全收的话每个没有 favicon 的域名都显示成同一坨灰块 —— 比统一的钥匙
 * 图标还难看，而那正是我们要解决的问题。
 *
 * 好消息是占位图对所有未知域名**字节完全一致**（实测三个不存在的域名
 * sha256 相同），所以按指纹能可靠地认出来。
 *
 * ### 二、首次抓取要 1.5 秒
 *
 * 服务端要**自己去抓**那个站点的 favicon，第一次慢，之后它自己缓存
 * （响应头写着 `cache-control: public, immutable, max-age=2592000`）。
 * 所以这里必须缓存，而且不能阻塞列表渲染 —— 见 `IconStore`。
 *
 * ## 关于那个哈希常量
 *
 * 它是**观测来的**，不是接口契约的一部分。Vaultwarden 哪天换了占位图，
 * 这个常量就失效，后果是「我们显示他们那张新占位图」——
 * 一个观感问题，不是安全问题，也不会损坏任何数据。
 * 换掉的办法：拿一个不存在的域名请求一次，把 sha256 抄到这里。
 */
/**
 * 服务端在没有图标时返回的那张占位图的指纹。
 *
 * 观测自 Vaultwarden：19×19 的灰色地球，483 字节。
 */
export const PLACEHOLDER_ICON_SHA256 = '01d7ddb3c3c46ca24f7d911abd32849aa19627c8be515273bdfb98100460aacb';
/** 同一张图的字节数 —— 先用它挡掉绝大多数真图标，省下算摘要的开销 */
export const PLACEHOLDER_ICON_BYTES = 483;

/** 服务端图标的地址。域名要转义，它是路径的一段而不是可以随便拼的字符串 */
export function iconUrlFor(serverUrl: string, domain: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/icons/${encodeURIComponent(domain)}/icon.png`;
}

/**
 * 这一段字节是不是那张占位图。
 *
 * 先比长度再算摘要：真图标动辄几十 KB，绝大概率在第一步就被排除，
 * 不用为列表里每一条都算一次 SHA-256。
 *
 * ⚠️ **长度相同也必须比内容。** 只比长度的话，一张刚好 483 字节的真实
 * favicon 会被我们当成占位图丢掉，用户看到的是字母徽标 ——
 * 一个「看起来正常」的错误结果，比报错更难发现。
 */
export async function isPlaceholderIcon(bytes: Uint8Array): Promise<boolean> {
  if (bytes.length !== PLACEHOLDER_ICON_BYTES) return false;
  // slice() 拿到的是自己的 ArrayBuffer，省掉 Uint8Array<ArrayBufferLike>
  // 与 BufferSource 之间的类型纠缠
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return toHex(new Uint8Array(digest)) === PLACEHOLDER_ICON_SHA256;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 磁盘缓存。**只存图标**（公开资源，不含任何用户数据）。
 *
 * ⚠️ 和密文缓存分开一个接口，是因为它们的**体量与寿命完全不同**：
 * 密文缓存一个账户一份、几百 KB；图标是每个域名一份、几十 KB，
 * 而域名可能有几百个。混在一个存储里会互相挤配额。
 *
 * 实现方用 IndexedDB 而不是 localStorage —— 后者 5MB 的配额
 * 在 250 个域名面前不够（每个 data URL 约 40KB）。
 */
export interface IconDiskCache {
  get(domain: string): Promise<string | null>;
  set(domain: string, dataUrl: string): Promise<void>;
}

export interface IconStoreOptions {
  serverUrl: string;
  /** 取字节。桌面端走 Rust 的原生 HTTP（WebView 跨源拿不到这个接口） */
  fetchBytes: (url: string) => Promise<Uint8Array | null>;
  /**
   * 磁盘缓存。不给就只在内存里缓存 —— 每次启动会重新拉一遍。
   *
   * ⚠️ 图标是**公开资源**（服务端那个接口不需要认证），所以存盘没有任何
   * 隐私顾虑 —— 这和一些人的直觉相反，值得写下来：它不是凭据。
   */
  disk?: IconDiskCache;
}

/**
 * 图标缓存。
 *
 * ⚠️ 缓存的是 **Promise**，不是结果 —— 列表首次渲染会**并发**问同一个域名
 * （列表里多条登录指向同一个站点是常态），缓存结果的话它们会同时穿透，
 * 发出 N 个一模一样的请求。缓存 Promise 才真的只发一次。
 *
 * 失败的结果也缓存。不缓存的话，一个没有图标的域名会在每次重渲时重试，
 * 而那是 1.5 秒一次的网络请求。
 */
export class IconStore {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: IconStoreOptions) {}

  /**
   * 返回可直接塞进 `<img src>` 的 data URL；**没有图标时返回 null**，
   * 调用方据此改用彩色字母徽标。
   *
   * 用 data URL 而不是 object URL：后者要配对 revoke，漏一次就泄漏一份
   * 图片常驻内存，而图标很小（几十 KB），data URL 的开销可以接受，
   * 也没有生命周期要管。
   */
  get(domain: string): Promise<string | null> {
    const hit = this.cache.get(domain);
    if (hit !== undefined) return hit;

    const pending = this.load(domain);
    this.cache.set(domain, pending);
    return pending;
  }

  private async load(domain: string): Promise<string | null> {
    // ① 磁盘。比网络快几个数量级，而这条链路上一次往返是 1.5~10 秒
    const onDisk = await this.opts.disk?.get(domain).catch(() => null);
    if (onDisk != null) return onDisk;

    // ⚠️ **整段**都在 try 里，不只是取字节那一步。
    // 判别占位图要算 SHA-256，而那需要 `crypto.subtle`（只在安全上下文里有）。
    // 万一它不在，异常必须在这里止住 —— 图标少一个只是回退到彩色徽标，
    // 让它冒出去则是整个列表渲染不出来。
    try {
      const bytes = await this.opts.fetchBytes(iconUrlFor(this.opts.serverUrl, domain));
      if (bytes === null || bytes.length === 0) return null;
      if (await isPlaceholderIcon(bytes)) return null;
      const dataUrl = `data:image/png;base64,${toBase64(bytes)}`;
      // 写盘失败不该影响这次显示 —— 只是下次还得重新拉
      void this.opts.disk?.set(domain, dataUrl).catch(() => {});
      return dataUrl;
    } catch {
      return null;
    }
  }
}

/** 分块 —— `String.fromCharCode(...bytes)` 在大图（512×512 的 favicon）上会撑爆参数列表 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
