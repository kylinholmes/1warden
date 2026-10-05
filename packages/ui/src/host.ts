/**
 * **宿主** —— 「这个界面跑在什么上面」的运行时接口。
 *
 * ## 为什么需要它
 *
 * 两端**界面是同一份**（这一轮合并了列表行、详情零件、导航栏、外壳布局）。
 * 真正不同的只剩两件事：
 *
 * | | 桌面端 | 扩展端 |
 * |---|---|---|
 * | **发请求** | 走 Rust（WebView 的 origin 是 `tauri://`，跨源被 CORS 拦） | 直接 `fetch`（有 host permission，不受 CORS 限制） |
 * | **落盘存储** | `localStorage` | `chrome.storage.local` |
 *
 * 这两件事以前散在两份 `client.ts` / `sync-cache.ts` / `icon-store.ts` 里 ——
 * 于是「哪些是真差异、哪些只是没合并」看不出来。收进一个接口之后，
 * **差异就只有这两行**，其余全是共享的。
 *
 * ## 为什么是模块级单例而不是 React Context
 *
 * 宿主是**进程级**的事实：一个窗口跑在桌面端上，或者跑在浏览器里，
 * 不会在渲染树中间发生变化。用 Context 会把它变成「某个子树可能有、
 * 可能没有」的东西 —— 而那不是事实，只是多一层要传的参数。
 *
 * ## ⚠️ 没装就抛错，不给默认值
 *
 * 默认值会让「忘了装宿主」表现成「功能悄悄不对」（比如用 `fetch` 直连
 * 而在桌面端全被 CORS 拦掉，报错却是「连不上服务器」）。抛错则一眼看到
 * 问题在哪。这和 `ext-api.ts` 那条经验是同一条：**别让错误伪装成别的东西**。
 */

export interface HostStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Host {
  /**
   * 发 HTTP。
   *
   * ⚠️ 签名是完整的 `typeof fetch` —— 因为它要**直接交给** `VaultClient`
   * 的 `fetchImpl` 接缝。我一度把它收窄成 `(url, init) => Response`，
   * 想用类型表达「桌面端那条路不是 fetch 的完整替代品」，结果当场挡住了
   * 唯一的消费者。**警告写在注释里就够了，不该写进类型里** ——
   * 类型要做的是让对的用法通过，不是让可能的误用变得难写。
   *
   * 实际限制（桌面端）：流式读取、`AbortSignal`、自定义 `cache` 那些
   * 由 Rust 侧决定支持多少，见 `apps/desktop/src/transport.ts` 顶部。
   */
  fetch: typeof fetch;

  /** 落盘存储。**只放密文与偏好** —— 明文密钥永不落盘（spec 不变量 S1） */
  storage: HostStorage;
}

let current: Host | null = null;

/** 各 app 在启动时调用一次。重复安装会抛错 —— 那多半是两个入口同时跑起来了 */
export function installHost(host: Host): void {
  if (current !== null) throw new Error('宿主已经装过了 —— 一个进程只该有一个入口');
  current = host;
}

export function host(): Host {
  if (current === null) {
    throw new Error(
      '宿主还没装。各 app 的入口要在一开始调用 `installHost(...)` —— ' +
        '见 packages/ui/src/host.ts 顶部对「为什么不给默认值」的说明。',
    );
  }
  return current;
}

/** 仅供测试：装一个假的宿主，用完丢掉 */
export function resetHost(): void {
  current = null;
}
