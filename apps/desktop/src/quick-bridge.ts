/**
 * 快速面板 ↔ 主窗口的通信。
 *
 * ## 为什么面板不自己持有会话
 *
 * 快速面板是一个**独立窗口**，有自己的 JS 上下文 —— 主窗口内存里的会话它
 * 天然拿不到。看上去最直接的做法是把解好的条目通过 Tauri 的 event 传过去，
 * 但那意味着**明文密码跨 IPC 边界序列化**，而 spec 对密钥这一层的要求是
 * 「跨进程边界时绝不能序列化它」。
 *
 * 所以面板从头到尾**不持有任何密文或明文**：它只发查询、收结果。
 *
 *   quick  ──coffer:query {query}──▶  main（唯一持有会话的地方）
 *   quick  ◀─coffer:results {items}─  main   ← 只有名称与用户名，没有密码
 *   quick  ──coffer:action {...}───▶  main   ← 复制/输入由主窗口执行
 *
 * 面板能看到的最敏感的东西是「用户名」。密码连它都看不到。
 */
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 面板能拿到的条目摘要 —— **刻意不含密码与验证码** */
export interface QuickItem {
  id: string;
  name: string;
  username: string | null;
  /** 有没有密码/验证码，只用于决定按钮显不显示 */
  hasPassword: boolean;
  hasTotp: boolean;
}

/** 面板能触发的动作。刻意只有复制 —— 见 QuickAccess 顶部的说明。 */
export type QuickAction = 'copy-password' | 'copy-username' | 'copy-totp';

export interface QuickResults {
  /** 查询序号 —— 异步返回时用来丢弃过期结果 */
  seq: number;
  locked: boolean;
  items: QuickItem[];
}

export const QUICK_WINDOW = 'quick';
export const MAIN_WINDOW = 'main';

/** 面板 → 主窗口：搜什么 */
export function askMain(query: string, seq: number): Promise<void> {
  return emitTo(MAIN_WINDOW, 'coffer:query', { query, seq });
}

/** 主窗口 → 面板：搜到了什么 */
export function onResults(fn: (r: QuickResults) => void): Promise<UnlistenFn> {
  return listen<QuickResults>('coffer:results', (e) => fn(e.payload));
}

/** 面板 → 主窗口：执行动作（复制 / 输入） */
export function askAction(itemId: string, action: QuickAction): Promise<void> {
  return emitTo(MAIN_WINDOW, 'coffer:action', { itemId, action });
}

/** 主窗口 → 面板：动作结果，用来给用户一句反馈 */
export function onActionResult(fn: (r: { ok: boolean; message: string }) => void): Promise<UnlistenFn> {
  return listen<{ ok: boolean; message: string }>('coffer:action-result', (e) => fn(e.payload));
}

/** 面板 → 主窗口：我需要一份初始结果（面板刚显示出来时） */
export function askInitial(seq: number): Promise<void> {
  return emitTo(MAIN_WINDOW, 'coffer:query', { query: '', seq });
}
