/**
 * Offscreen documents cannot receive focus, so Chromium rejects the async
 * Clipboard API here even with clipboardRead/clipboardWrite permissions.
 * Use the extension-permitted DOM commands, as in Chrome's offscreen example.
 */
export function clearOffscreenClipboardIfUnchanged(expected: string): void {
  const buffer = document.createElement('textarea');
  document.body.append(buffer);
  try {
    buffer.focus();
    if (!document.execCommand('paste')) throw new Error('无法读取剪贴板以执行到期清理');
    if (buffer.value !== expected) return;

    // Selecting an empty textarea reports success without clearing the OS
    // clipboard. Supply an explicit empty text payload in the copy event.
    buffer.value = ' ';
    buffer.select();
    const copyEmpty = (event: ClipboardEvent) => {
      event.clipboardData?.setData('text/plain', '');
      event.preventDefault();
    };
    document.addEventListener('copy', copyEmpty);
    try {
      if (!document.execCommand('copy')) throw new Error('无法清空到期的剪贴板内容');
    } finally {
      document.removeEventListener('copy', copyEmpty);
    }
  } finally {
    buffer.value = '';
    buffer.remove();
  }
}
