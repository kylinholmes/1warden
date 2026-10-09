import { copyWithAutoClear } from '@1warden/ui';
import { copyWindowsClipboard, usesWindowsNativeClipboard } from './native-clipboard';
/** Main-window only: quick receives success/failure, never the copied value. */
export async function copyQuickValue(value: string): Promise<void> {
  if (usesWindowsNativeClipboard()) {
    await copyWindowsClipboard(value);
    return;
  }
  await copyWithAutoClear(value);
}
