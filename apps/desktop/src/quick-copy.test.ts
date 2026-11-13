import { afterEach, expect, it, vi } from 'vitest';
import { copyQuickValue } from './quick-copy';
import { setClipboardClearMs } from '@1warden/ui/clipboard';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(), native: true, os: 'win' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@1warden/ui', () => ({ copyWithAutoClear: mocks.copy }));
vi.mock('./capabilities', () => ({ tauriAvailable: () => mocks.native }));
vi.mock('./platform', () => ({ detectOs: () => mocks.os }));
afterEach(() => { vi.clearAllMocks(); mocks.native = true; mocks.os = 'win'; setClipboardClearMs(30_000); });
it('Windows quick actions do not write through the unfocused document clipboard', async () => {
  await copyQuickValue('synthetic');
  expect(mocks.invoke).toHaveBeenCalledWith('clipboard_copy', { value: 'synthetic', clearAfterSeconds: 30 });
  expect(mocks.copy).not.toHaveBeenCalled();
});
it('passes the selected expiry to native copies', async () => {
  setClipboardClearMs(10_000);
  await copyQuickValue('synthetic');
  expect(mocks.invoke).toHaveBeenCalledWith('clipboard_copy', { value: 'synthetic', clearAfterSeconds: 10 });
});
it('preserves the existing non-Windows implementation', async () => {
  mocks.os = 'mac'; await copyQuickValue('synthetic');
  expect(mocks.copy).toHaveBeenCalledWith('synthetic'); expect(mocks.invoke).not.toHaveBeenCalled();
});
it('does not silently fall back or report success if native copy fails', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('busy'));
  await expect(copyQuickValue('synthetic')).rejects.toThrow('busy'); expect(mocks.copy).not.toHaveBeenCalled();
});
