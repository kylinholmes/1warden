import { invoke } from '@tauri-apps/api/core';
import { copyWithAutoClear } from '@1warden/ui';
import { detectOs } from './platform';
import { tauriAvailable } from './capabilities';
/** Main-window only: quick receives success/failure, never the copied value. */
export async function copyQuickValue(value: string): Promise<void> {
  if (tauriAvailable() && detectOs() === 'win') {
    await invoke('clipboard_copy', { value });
    return;
  }
  await copyWithAutoClear(value);
}
