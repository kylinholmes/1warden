import { invoke } from '@tauri-apps/api/core';
import { installNativeClipboardCopy } from '@1warden/ui/clipboard';
import { tauriAvailable } from './capabilities';
import { detectOs } from './platform';

export function usesWindowsNativeClipboard(): boolean {
  return tauriAvailable() && detectOs() === 'win';
}

/** Main-window only. Rust writes and expires by owner + private copy marker;
 * it never returns clipboard text or keeps plaintext for the expiry timer.
 */
export async function copyWindowsClipboard(value: string): Promise<void> {
  await invoke('clipboard_copy', { value });
}

/** Install before any UI copy can run. Do not patch browser globals or grant
 * clipboard-read permission to the embedded page.
 */
export function installDesktopClipboard(): void {
  if (usesWindowsNativeClipboard()) installNativeClipboardCopy(copyWindowsClipboard);
}
