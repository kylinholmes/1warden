import { ext } from './ext-api';
import { CLIPBOARD_CLEAR_MS } from '@coffer/ui/clipboard';
import { clearOffscreenClipboardIfUnchanged } from './offscreen-clipboard';

// Chrome's offscreen document outlives popup.html and owns the clipboard timer.
let timer: ReturnType<typeof setTimeout> | null = null;

ext.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== ext.runtime.id || sender.tab !== undefined) return undefined;
  const msg = message as { type?: string; value?: unknown; deadline?: unknown } | null;
  if (msg?.type !== 'coffer-internal:schedule-clear' || typeof msg.value !== 'string') return undefined;
  if (timer !== null) clearTimeout(timer);
  const value = msg.value;
  const deadline = typeof msg.deadline === 'number' && Number.isFinite(msg.deadline)
    ? msg.deadline : Date.now() + CLIPBOARD_CLEAR_MS;
  timer = setTimeout(() => {
    timer = null;
    try { clearOffscreenClipboardIfUnchanged(value); }
    catch (error) { console.warn('[coffer] 剪贴板清理失败', error); }
  }, Math.max(0, deadline - Date.now()));
  return undefined;
});
