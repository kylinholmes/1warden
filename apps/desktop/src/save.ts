/**
 * 保存文件。
 *
 * ⚠️ 走 `invoke` 而不是浏览器那套（`<a download>` / Blob URL）：
 * 这是 Tauri 应用，页面跑在 WebView 里，而 WebView 的下载行为在 macOS 上
 * 会落到用户看不见的地方、或者干脆什么都不发生。
 * 「存到哪」必须由系统对话框回答 —— 见 `src-tauri/src/save.rs` 的说明。
 */
import { invoke } from '@tauri-apps/api/core';
import { IS_DESKTOP } from '@1warden/ui';
import { toBase64 } from './base64';

export interface SaveOutcome {
  /** 用户取消时为 null —— 那**不是错误**，界面不该报错 */
  path: string | null;
}

export async function saveFile(defaultName: string, bytes: Uint8Array): Promise<SaveOutcome> {
  /*
   * ⚠️ 移动端**没有 `save_file` 这条命令** —— 它在 Rust 侧是 `#[cfg(desktop)]`。
   *
   * 不拦的话，`invoke` 会抛一句英文的 `command save_file not found`，
   * 然后被 `AttachmentRow` 的 catch 原样显示成「取不回来」——
   * 用户和排查的人都看不出真正的原因是「这个平台没有这个东西」。
   *
   * 正常路径下走不到这里：`canSaveFiles()` 会在移动端返回 false，
   * 「取回」按钮根本不渲染。这条是**兜底**，守的是将来某个新调用点。
   */
  if (!IS_DESKTOP) {
    throw new Error('移动端还不能把附件存成文件');
  }
  return invoke<SaveOutcome>('save_file', {
    defaultName,
    // 二进制过 IPC 只能编码 —— Tauri 的 IPC 是 JSON
    bytesBase64: toBase64(bytes),
  });
}

/**
 * 要不要显示「取回」按钮。
 *
 * 两个条件都要满足，而且理由完全不同：
 *
 * - `IS_DESKTOP` —— **这个平台有没有这条路**。移动端没有：那边该走的是
 *   分享面板（「存到文件」），不是「另存为」。⚠️ 这一条**还没做**，
 *   所以现在移动端上附件是**看得到、取不回**的 —— 记在
 *   docs/restructure-plan.md，别让它悄悄消失。
 * - `__TAURI_INTERNALS__` —— 预览页跑在**普通浏览器**里，没有 Tauri 壳。
 */
export function canSaveFiles(): boolean {
  return IS_DESKTOP && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
