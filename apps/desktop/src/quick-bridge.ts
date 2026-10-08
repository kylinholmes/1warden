/**
 * 快速面板 ↔ 主窗口的通信。
 *
 * ## 为什么面板不自己持有会话
 *
 * 快速面板是一个**独立窗口**，有自己的 JS 上下文 —— 主窗口内存里的会话它
 * 天然拿不到。看上去最直接的做法是把解好的条目通过 Tauri 的 event 传过去，
 * 但那意味着把明文密码和会话信息暴露给本来只负责搜索的第二个 WebView。
 *
 * 所以面板不持有密码、密钥或条目密文：它只发查询、收摘要。
 * Windows 的显式复制由主窗口调用仅 main 可用的原生剪贴板命令；
 * 只有待复制的那段文本进入系统剪贴板，密钥和整库数据不参与该调用。
 *
 *   quick  ──1warden:query {query}──▶  main（唯一持有会话的地方）
 *   quick  ◀─1warden:results {items}─  main   ← 只有名称与用户名，没有密码
 *   quick  ──1warden:action {...}───▶  main   ← 复制/输入由主窗口执行
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

  /*
   * ── 显示用的字段 ──
   *
   * 面板是**另一个窗口**，拿不到主窗口的 `VaultItem`，所以这些在主窗口那边
   * 算好了过桥。不这样做的话，`summaryOf` / `avatarOf` 那套规则要在两个
   * 窗口里各实现一遍 —— 而它们迟早会不一致。
   */
  /** 条目类型，决定没有站点时画哪个类型图标 */
  type: string;
  /** 列表第二行（`summaryOf` 的结果）。null = 这行不显示 */
  summary: string | null;
  /** 有站点时是那个域名，用来取图标；没有则为 null */
  iconDomain: string | null;
  /** 彩色徽标上写什么字（`avatarOf` 的结果） */
  avatarText: string;
  /** 徽标色相（`avatarOf` 的结果），0–359 */
  avatarHue: number;
}

/** 面板能触发的动作。刻意只有复制 —— 见 QuickAccess 顶部的说明。 */
export type QuickAction = 'copy-password' | 'copy-username' | 'copy-totp';

export interface QuickResults {
  /** 查询序号 —— 异步返回时用来丢弃过期结果 */
  seq: number;
  locked: boolean;
  items: QuickItem[];
  /**
   * 服务端地址 —— 面板要拿它取站点图标。
   *
   * 每次结果都带上而不是握手时给一次：面板可能比主窗口先起来，
   * 「先要一次」那条路会在启动时序上打架。这个值很小，重复带没关系。
   */
  serverUrl: string | null;
}

export const QUICK_WINDOW = 'quick';
export const MAIN_WINDOW = 'main';

/** 面板 → 主窗口：搜什么 */
export function askMain(query: string, seq: number): Promise<void> {
  return emitTo(MAIN_WINDOW, '1warden:query', { query, seq });
}

/** 主窗口 → 面板：搜到了什么 */
export function onResults(fn: (r: QuickResults) => void): Promise<UnlistenFn> {
  return listen<QuickResults>('1warden:results', (e) => fn(e.payload));
}

/** 面板 → 主窗口：执行动作（复制 / 输入） */
export function askAction(itemId: string, action: QuickAction, requestId?: number): Promise<void> {
  return emitTo(MAIN_WINDOW, '1warden:action', { itemId, action, requestId });
}

/** 主窗口 → 面板：动作结果，用来给用户一句反馈 */
export function onActionResult(fn: (r: { ok: boolean; message: string; requestId?: number }) => void): Promise<UnlistenFn> {
  return listen<{ ok: boolean; message: string; requestId?: number }>('1warden:action-result', (e) => fn(e.payload));
}

/** 面板 → 主窗口：我需要一份初始结果（面板刚显示出来时） */
export function askInitial(seq: number): Promise<void> {
  return emitTo(MAIN_WINDOW, '1warden:query', { query: '', seq });
}
