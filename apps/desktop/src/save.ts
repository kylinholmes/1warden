/**
 * 保存文件。
 *
 * ⚠️ 走 `invoke` 而不是浏览器那套（`<a download>` / Blob URL）：
 * 这是 Tauri 应用，页面跑在 WebView 里，而 WebView 的下载行为在 macOS 上
 * 会落到用户看不见的地方、或者干脆什么都不发生。
 * 「存到哪」必须由系统对话框回答 —— 见 `src-tauri/src/save.rs` 的说明。
 */
import { invoke } from '@tauri-apps/api/core';
import { toBase64 } from './base64';

export interface SaveOutcome {
  /** 用户取消时为 null —— 那**不是错误**，界面不该报错 */
  path: string | null;
}

export async function saveFile(defaultName: string, bytes: Uint8Array): Promise<SaveOutcome> {
  return invoke<SaveOutcome>('save_file', {
    defaultName,
    // 二进制过 IPC 只能编码 —— Tauri 的 IPC 是 JSON
    bytesBase64: toBase64(bytes),
  });
}

/** 预览页跑在浏览器里，没有 Tauri —— 用它决定要不要显示「取回」 */
export function canSaveFiles(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
