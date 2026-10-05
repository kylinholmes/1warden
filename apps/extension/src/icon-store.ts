/**
 * 弹窗侧的图标缓存。
 *
 * 和桌面端那两个（`apps/desktop/src/icon-store.ts`、快速面板用的同一个）
 * 是**同一件事的两种接法**，差别只在一处：怎么发请求。
 *
 *   桌面端：WebView 的 origin 是 `tauri://localhost`，跨源会被 CORS 拦掉，
 *          只能走 Rust 的原生 HTTP（见 @coffer/vault 里 IconStore 的说明）
 *   弹窗：  扩展自己有 `host_permissions`，可以直接 fetch
 *
 * 规则、缓存策略、占位图识别全在 `@coffer/vault` 的 `IconStore` 里，
 * 两边共用 —— 这里只负责把「怎么发请求」接上去。
 */
import { IconStore } from '@coffer/vault';

let cached: { serverUrl: string; store: IconStore } | null = null;

export function iconStoreFor(
  serverUrl: string,
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
): IconStore {
  if (cached !== null && cached.serverUrl === serverUrl) return cached.store;
  const store = new IconStore({ serverUrl, fetchBytes });
  cached = { serverUrl, store };
  return store;
}
