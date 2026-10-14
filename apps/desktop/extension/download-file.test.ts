import { expect, it, vi } from 'vitest';
import { downloadFile } from './download-file';

function fixture() {
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const terminal = (id: number, state: string, error?: string) => {
    for (const listener of listeners) listener({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) } as chrome.downloads.DownloadDelta);
  };
  const downloads = { download: vi.fn(async () => 7), search: vi.fn(async () => [{ id: 7, state: 'in_progress' }]),
    onChanged: { addListener: (callback: (delta: chrome.downloads.DownloadDelta) => void) => listeners.add(callback),
      removeListener: (callback: (delta: chrome.downloads.DownloadDelta) => void) => listeners.delete(callback) } };
  return { downloads: downloads as unknown as typeof chrome.downloads, terminal, listeners };
}
it('waits for completion before reporting a saved file and releasing its Blob URL', async () => {
  const { downloads, terminal, listeners } = fixture();
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  let settled = false;
  const saving = downloadFile(downloads, 'backup.json', 'YWJj').then(result => { settled = true; return result; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); expect(revoke).not.toHaveBeenCalled();
  terminal(8, 'complete'); expect(settled).toBe(false);
  terminal(7, 'complete');
  expect(await saving).toEqual({ path: 'backup.json' });
  expect(revoke).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0); revoke.mockRestore();
});
it('reports cancellation separately from write failure, including cancelling the picker', async () => {
  const { downloads, terminal } = fixture();
  const saving = downloadFile(downloads, 'backup.json', 'YWJj');
  await Promise.resolve(); await Promise.resolve(); terminal(7, 'interrupted', 'USER_CANCELED');
  expect(await saving).toEqual({ path: null });
  vi.mocked(downloads.download).mockRejectedValueOnce(new Error('Download canceled by the user'));
  expect(await downloadFile(downloads, 'backup.json', 'YWJj')).toEqual({ path: null });
  const failed = downloadFile(downloads, 'backup.json', 'YWJj');
  const rejected = expect(failed).rejects.toThrow(/FILE_NO_SPACE/);
  await Promise.resolve(); await Promise.resolve(); terminal(7, 'interrupted', 'FILE_NO_SPACE'); await rejected;
});
it('handles a terminal change delivered before the start promise resolves', async () => {
  const { downloads, terminal } = fixture();
  vi.mocked(downloads.download).mockImplementation(async () => { terminal(7, 'complete'); return 7; });
  expect(await downloadFile(downloads, 'backup.json', 'YWJj')).toEqual({ path: 'backup.json' });
});
