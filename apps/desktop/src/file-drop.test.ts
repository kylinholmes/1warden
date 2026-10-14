// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeFileDrops, type DroppedFile, type FileDropCallbacks } from './file-drop';

const native = vi.hoisted(() => ({ label: 'main', invoke: vi.fn(), listen: vi.fn(), off: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: native.label, listen: native.listen }) }));

let off: (() => void) | undefined;
let nativeEvent: (event: { payload: unknown }) => void;
const callbacks = (extra: Pick<FileDropCallbacks, 'onDropStart'> = {}) => ({ onDragging: vi.fn(), onDrop: vi.fn(), onError: vi.fn(), ...extra });
function start(extra: Pick<FileDropCallbacks, 'onDropStart'> = {}) { const cb = callbacks(extra); off = subscribeFileDrops(cb); return cb; }
function enableNative() { Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} }); }
function drag(type: string, files: File[] = [], items?: unknown[], types = ['Files']) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: items ?? files.map(() => ({ kind: 'file' })), types } });
  document.body.dispatchEvent(event); return event;
}
function pendingFile() {
  const file = new File(['original'], 'vault.json');
  let resolve!: (value: ArrayBuffer) => void;
  const arrayBuffer = vi.fn(() => new Promise<ArrayBuffer>(r => { resolve = r; }));
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
  return { file, arrayBuffer, resolve: () => resolve(new Uint8Array([0, 137, 255]).buffer) };
}
beforeEach(() => {
  native.label = 'main'; native.invoke.mockReset(); native.listen.mockReset(); native.off.mockReset();
  native.listen.mockImplementation(async (_event, callback) => { nativeEvent = callback; return native.off; });
});
afterEach(() => {
  off?.(); off = undefined;
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  document.documentElement.removeAttribute('data-quick-window');
  vi.restoreAllMocks();
});

describe('browser window file drops', () => {
  it('prevents file navigation and emits original binary bytes once', async () => {
    const cb = start();
    expect(drag('dragover').defaultPrevented).toBe(true);
    expect(drag('drop', [new File([new Uint8Array([0, 137, 255])], 'vault.json')]).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(cb.onDrop).toHaveBeenCalledExactlyOnceWith({ name: 'vault.json', dataBase64: 'AIn/' }));
    expect(cb.onDragging).toHaveBeenLastCalledWith(false);
    expect(cb.onError).not.toHaveBeenCalled();
  });
  it('keeps the drag overlay while moving between nested elements and ignores text drags', () => {
    const cb = start();
    drag('dragenter'); drag('dragenter'); drag('dragleave');
    expect(cb.onDragging).toHaveBeenLastCalledWith(true);
    drag('dragleave'); expect(cb.onDragging).toHaveBeenLastCalledWith(false);
    cb.onDragging.mockClear();
    expect(drag('dragover', [], [], ['text/plain']).defaultPrevented).toBe(false);
    expect(cb.onDragging).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'multiple files', files: [new File(['a'], 'a.json'), new File(['b'], 'b.json')], error: /一个/ },
    { name: 'empty file', files: [new File([], 'empty.json')], error: /空/ },
    { name: 'no readable files', files: [], error: /文件/ },
  ])('rejects $name visibly', async ({ files, error }) => {
    const cb = start(); drag('drop', files);
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(error)));
    expect(cb.onDrop).not.toHaveBeenCalled();
  });
  it('rejects directories and oversized files before reading', async () => {
    const cb = start(); const pending = pendingFile();
    drag('drop', [pending.file], [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }]);
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/文件夹/)));
    Object.defineProperty(pending.file, 'size', { value: 50 * 1024 * 1024 + 1 });
    drag('drop', [pending.file]);
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/50 MiB/)));
    expect(pending.arrayBuffer).not.toHaveBeenCalled();
  });
  it('lets the owner reject a drop before any read', async () => {
    const cb = start({ onDropStart: () => false }); const pending = pendingFile();
    drag('drop', [pending.file]); await Promise.resolve();
    expect(pending.arrayBuffer).not.toHaveBeenCalled(); expect(cb.onDrop).not.toHaveBeenCalled();
  });
  it('shows a readable file-read error and accepts a later retry', async () => {
    const cb = start(); const failed = new File(['{}'], 'vault.json');
    Object.defineProperty(failed, 'arrayBuffer', { value: () => Promise.reject(Error('文件读取失败')) });
    drag('drop', [failed]);
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledWith('文件读取失败'));
    drag('drop', [new File(['{}'], 'retry.json')]);
    await vi.waitFor(() => expect(cb.onDrop).toHaveBeenCalledExactlyOnceWith({ name: 'retry.json', dataBase64: 'e30=' }));
  });
  it.each(['account switch', 'unmount'] as const)('discards a late read after %s', async reason => {
    let current = true; const cb = start({ onDropStart: () => () => current }); const pending = pendingFile();
    drag('drop', [pending.file]);
    await vi.waitFor(() => expect(pending.arrayBuffer).toHaveBeenCalledOnce());
    if (reason === 'unmount') off?.(); else current = false;
    pending.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(cb.onDrop).not.toHaveBeenCalled(); expect(cb.onError).not.toHaveBeenCalled();
  });
  it('rejects a concurrent drop without replacing the pending read', async () => {
    const cb = start(); const first = pendingFile(); const second = pendingFile();
    drag('drop', [first.file]); drag('drop', [second.file]);
    expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/读取/));
    expect(second.arrayBuffer).not.toHaveBeenCalled(); first.resolve();
    await vi.waitFor(() => expect(cb.onDrop).toHaveBeenCalledOnce());
  });
  it('removes window handlers on cleanup', () => {
    const cb = start(); off?.(); cb.onDragging.mockClear();
    expect(drag('drop', [new File(['{}'], 'vault.json')]).defaultPrevented).toBe(false);
    expect(cb.onDragging).not.toHaveBeenCalled(); expect(cb.onDrop).not.toHaveBeenCalled();
  });
});

describe('native window file drops', () => {
  it('claims only the offered ID and ignores duplicate DOM delivery', async () => {
    enableNative(); native.invoke.mockResolvedValue({ name: 'vault.json', dataBase64: 'e30=' });
    const cb = start();
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalled());
    nativeEvent({ payload: { kind: 'dragging', dragging: true } });
    nativeEvent({ payload: { kind: 'offered', id: 'drop-1' } });
    nativeEvent({ payload: { kind: 'offered', id: 'drop-1' } });
    drag('drop', [new File(['other'], 'duplicate.json')]);
    await vi.waitFor(() => expect(cb.onDrop).toHaveBeenCalledExactlyOnceWith({ name: 'vault.json', dataBase64: 'e30=' }));
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('claim_dropped_file', { id: 'drop-1', accept: true });
    expect(cb.onDragging).toHaveBeenLastCalledWith(false);
  });
  it('discards rejected native IDs without requesting file bytes', async () => {
    enableNative(); native.invoke.mockResolvedValue(null);
    const cb = start({ onDropStart: () => false });
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalled());
    nativeEvent({ payload: { kind: 'offered', id: 'rejected' } });
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledExactlyOnceWith('claim_dropped_file', { id: 'rejected', accept: false }));
    expect(cb.onDrop).not.toHaveBeenCalled();
  });
  it('suppresses native read completion and errors after account invalidation', async () => {
    enableNative(); let current = true; let reject!: (error: string) => void;
    native.invoke.mockReturnValue(new Promise<DroppedFile>((_, fail) => { reject = fail; }));
    const cb = start({ onDropStart: () => () => current });
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalled());
    nativeEvent({ payload: { kind: 'offered', id: 'late' } });
    current = false; reject('文件无法读取'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(cb.onDrop).not.toHaveBeenCalled(); expect(cb.onError).not.toHaveBeenCalled();
  });
  it('unregisters listeners that finish registration after cleanup', async () => {
    enableNative(); let registered!: (off: () => void) => void;
    native.listen.mockReturnValue(new Promise<() => void>(r => { registered = r; }));
    start(); off?.(); registered(native.off);
    await vi.waitFor(() => expect(native.off).toHaveBeenCalledOnce());
  });
  it('ignores native events delivered after cleanup', async () => {
    enableNative(); const cb = start(); off?.();
    nativeEvent({ payload: { kind: 'offered', id: 'stale' } });
    await Promise.resolve();
    expect(native.invoke).not.toHaveBeenCalled(); expect(cb.onDrop).not.toHaveBeenCalled();
  });
  it.each(['native', 'browser'] as const)('ignores quick windows in %s mode', async mode => {
    if (mode === 'native') { enableNative(); native.label = 'quick'; }
    else document.documentElement.setAttribute('data-quick-window', '');
    const cb = start(); drag('drop', [new File(['{}'], 'vault.json')]);
    await Promise.resolve();
    expect(native.listen).not.toHaveBeenCalled(); expect(native.invoke).not.toHaveBeenCalled();
    expect(cb.onDrop).not.toHaveBeenCalled();
  });
});
