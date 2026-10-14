import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toBase64 } from './base64';
import { tauriAvailable } from './capabilities';

export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
type NativeDropEvent = { kind: 'dragging'; dragging: boolean } | { kind: 'offered'; id: string };

export interface DroppedFile { name: string; dataBase64: string }
export interface FileDropCallbacks {
  onDragging(dragging: boolean): void;
  onDrop(file: DroppedFile): void;
  onError(message: string): void;
  /** Reject before reading, or return a guard invalidated by account/lock/editor changes. */
  onDropStart?(): false | (() => boolean);
}

/** Main-window drops. Cleanup invalidates pending registration, reads and callbacks. */
export function subscribeFileDrops(callbacks: FileDropCallbacks): () => void {
  if (typeof window === 'undefined' || document.documentElement.hasAttribute('data-quick-window')) return () => {};
  const nativeWindow = tauriAvailable() ? getCurrentWindow() : null;
  if (nativeWindow && nativeWindow.label !== 'main') return () => {};

  let disposed = false;
  let reading = false;
  let depth = 0;
  let dragging = false;
  let lastNativeId: string | undefined;
  let unlisten: (() => void) | undefined;
  let abortRead: (() => void) | undefined;
  function setDragging(next: boolean) {
    if (disposed || dragging === next) return;
    dragging = next; callbacks.onDragging(next);
  }
  function resetDrag() { depth = 0; setDragging(false); }
  function begin(): (() => boolean) | null {
    if (disposed) return null;
    if (reading) { callbacks.onError('正在读取文件，请稍后再拖入'); return null; }
    const guard = callbacks.onDropStart?.();
    if (guard === false) return null;
    const current = () => !disposed && (guard?.() ?? true);
    return current() ? current : null;
  }
  async function receive(read: () => Promise<DroppedFile | null>, current: () => boolean) {
    reading = true;
    try {
      const file = await read();
      if (file && current()) callbacks.onDrop(file);
    } catch (error) {
      if (current()) callbacks.onError(typeof error === 'string' ? error : error instanceof Error ? error.message : '无法读取导入文件');
    } finally { reading = false; abortRead = undefined; }
  }
  function readBytes(file: File): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    // Older WebViews expose FileReader but not Blob.arrayBuffer.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(Error('无法读取导入文件'));
      reader.onabort = () => reject(Error('文件读取已取消'));
      abortRead = () => reader.abort();
      reader.readAsArrayBuffer(file);
    });
  }
  async function readBrowserFile(transfer: DataTransfer): Promise<DroppedFile> {
    const items = Array.from(transfer.items ?? []).filter(item => item.kind === 'file');
    if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) throw Error('不能导入文件夹，请拖入一个文件');
    if (transfer.files.length !== 1) throw Error('请一次拖入一个导入文件');
    const file = transfer.files[0]!;
    if (file.size === 0) throw Error('导入文件为空');
    if (file.size > MAX_IMPORT_FILE_BYTES) throw Error('导入文件不能超过 50 MiB');
    const bytes = new Uint8Array(await readBytes(file));
    if (bytes.length === 0) throw Error('导入文件为空');
    if (bytes.length > MAX_IMPORT_FILE_BYTES) throw Error('导入文件不能超过 50 MiB');
    return { name: file.name, dataBase64: toBase64(bytes) };
  }
  function hasFiles(event: DragEvent): event is DragEvent & { dataTransfer: DataTransfer } {
    const transfer = event.dataTransfer;
    return !!transfer && (Array.from(transfer.types ?? []).includes('Files') || transfer.files.length > 0);
  }
  function preventFileNavigation(event: DragEvent) {
    event.preventDefault(); event.stopPropagation();
  }
  const enter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    preventFileNavigation(event);
    if (!nativeWindow) { depth++; setDragging(true); }
  };
  const over = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    preventFileNavigation(event);
    if (!nativeWindow) setDragging(true);
  };
  const leave = (event: DragEvent) => {
    if (nativeWindow || !hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };
  const drop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    preventFileNavigation(event); resetDrag();
    // Tauri already handles OS drops. Reading a DOM File here would import twice.
    if (nativeWindow) return;
    const current = begin();
    if (current) void receive(() => readBrowserFile(event.dataTransfer), current);
  };
  window.addEventListener('dragenter', enter, true);
  window.addEventListener('dragover', over, true);
  window.addEventListener('dragleave', leave, true);
  window.addEventListener('drop', drop, true);
  window.addEventListener('blur', resetDrag);

  if (nativeWindow) {
    void nativeWindow.listen<NativeDropEvent>('1warden:file-drop', ({ payload }) => {
      if (disposed) return;
      if (payload.kind === 'dragging') { setDragging(payload.dragging); return; }
      resetDrag();
      if (payload.id === lastNativeId) return;
      lastNativeId = payload.id;
      const current = begin();
      if (!current) {
        // Discard the one-use native ticket without touching the file.
        void invoke('claim_dropped_file', { id: payload.id, accept: false }).catch(() => {});
        return;
      }
      void receive(() => invoke<DroppedFile | null>('claim_dropped_file', { id: payload.id, accept: true }), current);
    }).then(off => { if (disposed) off(); else unlisten = off; })
      .catch(() => { if (!disposed) callbacks.onError('无法接收拖入文件，请使用选择文件'); });
  }
  return () => {
    if (disposed) return;
    resetDrag(); disposed = true;
    unlisten?.(); abortRead?.();
    window.removeEventListener('dragenter', enter, true);
    window.removeEventListener('dragover', over, true);
    window.removeEventListener('dragleave', leave, true);
    window.removeEventListener('drop', drop, true);
    window.removeEventListener('blur', resetDrag);
  };
}
