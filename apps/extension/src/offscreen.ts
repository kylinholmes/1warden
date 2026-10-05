import { ext } from './ext-api';

/**
 * 离屏文档 —— 只干一件事：在 N 秒后清空剪贴板。
 *
 * ## 为什么不能就在弹窗里做
 *
 * 弹窗一关，它的定时器就没了。而「复制完忘了剪贴板里还有密码」正是弹窗
 * 已经关掉的那种情况 —— 在弹窗里做清理，等于安全网刚好漏掉它要接住的人。
 * 离屏文档独立于弹窗存活，弹窗关了它还在，定时器照跑。
 *
 * ## ⚠️ 这里只能用「发完不管」的消息
 *
 * 实测出来的两条事实，决定了这份代码的形状：
 *
 * 1. **消息投递是好的** —— `chrome.runtime.onMessage` 收得到。
 * 2. **应答回不去** —— 从这个文档调 `sendResponse`，无论发送方是 service
 *    worker 还是弹窗，拿回来的都是 `undefined`。background 里那个
 *    「ping 到就绪为止」的循环因此永远等不到 pong。
 * 3. **`chrome.storage` 在这里是 undefined** —— 想拿它当信箱也不行。
 *
 * 所以：**收到就干活，不回话**。剪贴板由弹窗写（它有用户手势，也拿得到成败），
 * 这里只负责按时清理。
 *
 * 用的是核心 API（`chrome.offscreen`），不是任何插件。
 *
 * ## 权限
 *
 * `clipboardWrite` 让扩展上下文不需要手势就能写剪贴板。
 * `clipboardRead` 用于清理前比对「还是不是我们写的东西」——
 * 少了它 `readText()` 会抛错、清理静默失效，界面上那句「30 秒后清空」
 * 就成了空头承诺。
 */

/** 剪贴板留存时长。与桌面端保持一致。 */
const CLEAR_AFTER_MS = 30_000;

let expected: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * ⚠️ 只有剪贴板里**还是我们写进去的东西**时才清。
 *
 * 无条件清空会在用户复制完密码、又复制了别的内容之后把后者抹掉 ——
 * 那是个让人莫名其妙的数据丢失。
 */
async function clearIfUnchanged(): Promise<void> {
  const value = expected;
  expected = null;
  timer = null;
  if (value === null) return;
  try {
    if (await navigator.clipboard.readText() === value) {
      await navigator.clipboard.writeText('');
    }
  } catch { /* 读不了就不动它 */ }
}

ext.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; value?: string };
  if (m?.type !== 'coffer-internal:schedule-clear' || typeof m.value !== 'string') {
    return undefined;
  }

  expected = m.value;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => { void clearIfUnchanged(); }, CLEAR_AFTER_MS);
  return undefined;   // 不回话 —— 应答本来就回不去
});
