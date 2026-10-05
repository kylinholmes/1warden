/**
 * 浏览器扩展 API 的命名空间 —— **两个浏览器统一成 Promise 式**。
 *
 * ## ⚠️ 这是 Firefox 适配里最要命的一处
 *
 * | | `chrome.*` | `browser.*` |
 * |---|---|---|
 * | Chrome / Edge | **返回 Promise**（MV3 起） | 不存在 |
 * | Firefox / Zen | **回调式**（不返回 Promise） | **返回 Promise** |
 *
 * 而我们全篇写的是 `await chrome.storage.session.get(...)`。在 Firefox 上
 * 那不是「拿到 undefined 再炸」—— `await undefined` **是合法的**，
 * 于是每一处存储调用都**静默失效**：不报错、不抛异常、只是什么都没发生。
 *
 * 症状就是我们看到的那一屏：popup 停在「正在载入…」，因为后台在启动时
 * 就没能把监听器注册上（它依赖 storage）。
 *
 * **实测过**：这一版之前在 Zen（Gecko 156）里就是停在那里。
 *
 * ## 做法
 *
 * `browser` 有就用 `browser`（Firefox 系），否则用 `chrome`（Chrome 系）。
 * 两者的 API 面相同，所以 `chrome.foo.bar()` 换成 `ext.foo.bar()` 是等价的 ——
 * 差别只在返回值。
 *
 * ⚠️ **新增代码一律用 `ext`，不要再直接用 `chrome`。** 直接用的话，
 * 在 Firefox 上又是一次静默失效 —— 而那种 bug 不会在 Chrome 上暴露，
 * 只有装了 Firefox 才会看到，代价很高。
 *
 * ⚠️ `ext.offscreen` 在 Firefox 上**不存在**（Firefox 系没有 offscreen API）。
 * 这里不假装它有，调用方要自己判空 —— 见 `background.ts` 里剪贴板清理那段。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const ext: typeof chrome = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;
