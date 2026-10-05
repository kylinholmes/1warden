/**
 * 弹窗侧的图标缓存。
 *
 * 和桌面端那两个（`apps/desktop/src/icon-store.ts`、快速面板用的同一个）
 * 是**同一件事的两种接法**，差别只在一处：怎么发请求。
 *
 *   桌面端：WebView 的 origin 是 `tauri://localhost`，跨源会被 CORS 拦掉，
 *          只能走 Rust 的原生 HTTP（见 @coffer/vault 里 IconStore 的说明）
 *   弹窗：  扩展自己有 host permissions，可以直接 fetch
 *
 * 规则、缓存策略、占位图识别全在 `@coffer/vault` 的 `IconStore` 里，
 * 两边共用 —— 这里只负责把「怎么发请求」接上去。
 */
import { IconStore } from '@coffer/vault';
import { indexedDbIconDisk } from '@coffer/ui';

let cached: { serverUrl: string; store: IconStore } | null = null;

export function iconStoreFor(
  serverUrl: string,
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
): IconStore {
  if (cached !== null && cached.serverUrl === serverUrl) return cached.store;
  /*
   * ⚠️ `disk` 不能省 —— 少了它，弹窗每次打开都要重新拉一遍图标
   * （内存缓存随弹窗关闭消失），而服务端首次抓一个域名要 1.5 秒。
   * 桌面端一直有这一份，扩展端因为那份实现住在 `apps/desktop` 里够不着 ——
   * 现在它搬进 `@coffer/ui` 了，两端共用。
   */
  const store = new IconStore({ serverUrl, fetchBytes, disk: indexedDbIconDisk });
  cached = { serverUrl, store };
  return store;
}
