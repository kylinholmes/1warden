/**
 * 剪贴板约定 —— **不含 React**，因为扩展的离屏文档也要用它。
 *
 * ⚠️ 单独一个模块而不是塞在 `CopyButton.tsx` 里：离屏文档是个极小的脚本，
 * 为了一个常量把 React 和整套图标打进去是不划算的。所以这里走
 * `@1warden/ui/clipboard` 这个独立入口（见 package.json 的 exports）。
 *
 * ## 这里定义的是一条**安全规则**，不是一个可调参数
 *
 * 剪贴板是明文密码离开这个应用之后唯一还留着它的地方，所以「复制」这个动作
 * 必须自带收尾。而收尾时**只有剪贴板里还是我们写进去的那个值时才清** ——
 * 无脑清空会抹掉用户在这 30 秒里后来复制的东西，那是个数据丢失 bug。
 */

/** 剪贴板里明文密码的存活时间。**只有这一处定义** —— 它是一条安全约定，不是一个调参 */
export const CLIPBOARD_CLEAR_MS = 30_000;

let scheduler: ((value: string) => void | Promise<void>) | null = null;
let nativeCopy: ((value: string) => Promise<void>) | null = null;

/** The browser background outlives the popup; unmanaged web views use a timer. */
export function installClipboardScheduler(handler: typeof scheduler): void {
  scheduler = handler;
}

/** Installed once by the native entry before rendering. A successful handler
 * must BOTH write and schedule conditional expiry. Never fall back to the web
 * clipboard on failure: doing so would restore permission prompts and change
 * the ownership guarantees. Extensions retain their background scheduler.
 */
export function installNativeClipboardCopy(handler: typeof nativeCopy): void {
  nativeCopy = handler;
}

/** Shared write boundary for buttons and non-button actions. Native copies
 * own their cleanup even if the caller has no onCopied callback.
 */
export async function writeClipboardText(value: string): Promise<void> {
  if (nativeCopy) { await nativeCopy(value); return; }
  await navigator.clipboard.writeText(value);
}

/**
 * 只清「还是我们写的那个值」。
 *
 * 读剪贴板可能被系统拒绝（没有用户手势、权限不足），那就**保持原样** ——
 * 宁可不清理，也不要误删用户后来复制的东西。
 */
export async function clearIfUnchanged(value: string): Promise<void> {
  // Native expiry uses its private ownership marker, never browser text reads.
  if (nativeCopy) return;
  try {
    if (await navigator.clipboard.readText() === value) await navigator.clipboard.writeText('');
  } catch { /* 见上 */ }
}

/**
 * 安排 N 秒后按值清空（值**已经**写进去了）。
 *
 * 桌面端每一处 `CopyButton` 都该传这个当 `onCopied` —— 光是这一行，
 * 就把「30 秒」和「只清自己写的那个值」两条规则钉在了同一个地方。
 */
export async function scheduleClipboardClear(value: string): Promise<void> {
  // The native write already scheduled expiry. Do not create a second timer
  // retaining plaintext or requesting WebView clipboard-read permission.
  if (nativeCopy) return;
  if (scheduler) { await scheduler(value); return; }
  setTimeout(() => { void clearIfUnchanged(value); }, CLIPBOARD_CLEAR_MS);
}

/**
 * 写剪贴板并安排清空 —— 「写进去 + 稍后按值收回」的完整约定。
 *
 * 给**没有按钮**的那些路径用（快速面板从原生菜单收到复制指令，
 * 那条路上没有可以点的地方）。
 */
export async function copyWithAutoClear(value: string): Promise<void> {
  await writeClipboardText(value);
  await scheduleClipboardClear(value);
}
