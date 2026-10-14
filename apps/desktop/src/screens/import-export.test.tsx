// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportScreen } from './Import';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ExportFile } from '../application/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of roots.splice(0)) await dispose(); });
async function mount(overrides: Partial<ApplicationClient> = {}, props: Record<string, unknown> = {}) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked' as const };
  const client = { getSnapshot: () => snapshot, subscribe: () => () => {},
    capabilities: { native: true, browser: false, saveAttachments: true }, ...overrides } as ApplicationClient;
  await act(() => root.render(createElement(StrictMode, null, createElement(ImportScreen, { client, onImported: () => {}, ...props }))));
  roots.push(async () => { await act(() => root.unmount()); host.remove(); });
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
    expect(button, text).toBeTruthy(); await act(() => button!.click());
  };
  return { host, root, client, click };
}
function input(host: HTMLElement, label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(field).toBeTruthy();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const preview = { fileName: 'backup.json', format: 'bitwarden-json' as const, formatLabel: 'JSON', total: 2,
  byType: { login: 2 }, folders: 0, skipped: [] };
it('keeps a partial import retryable and always skips existing records on retry', async () => {
  const importData = vi.fn().mockResolvedValueOnce({ created: 1, skippedExisting: 0, failed: [{ name: 'Second', reason: '网络中断' }] })
    .mockResolvedValueOnce({ created: 1, skippedExisting: 1, failed: [] });
  const { host, click } = await mount({ parseImport: async () => preview, importData },
    { droppedFile: { name: 'backup.json', dataBase64: 'YWJj' } });
  const checkbox = host.querySelector<HTMLInputElement>('input[aria-label="跳过已有条目"]');
  expect(checkbox?.checked).toBe(true);
  await act(() => checkbox!.click());
  await click('导入这 2 条');
  expect(importData.mock.calls[0]![0]).toMatchObject({ skipExisting: false });
  expect(host.textContent).toContain('网络中断');
  await click('跳过已有条目并重试');
  expect(importData.mock.calls[1]![0]).toMatchObject({ dataBase64: 'YWJj', skipExisting: true });
  expect(host.textContent).toContain('已跳过 1 条已有条目');
});
it('offers only other unlocked accounts and imports into the displayed current account', async () => {
  const target = { serverUrl: 'https://target.example', email: 'target@example.com', userId: 'target', kdf: { kdf: 0 as const, iterations: 1 } };
  const source = { serverUrl: 'https://source.example', email: 'source@example.com' };
  const importAccount = vi.fn(async () => ({ created: 2, skippedExisting: 0, failed: [] }));
  const previewAccountImport = vi.fn(async () => ({ ...preview, warnings: ['附件需要单独迁移'] }));
  const snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked' as const, account: target,
    unlockedAccounts: [JSON.stringify([target.serverUrl, target.email]), JSON.stringify([source.serverUrl, source.email])] };
  const { host, click } = await mount({ getSnapshot: () => snapshot,
    previewAccountImport, importAccount });
  await click('从其他账户迁移');
  expect(host.textContent).toContain('target@example.com');
  const selector = host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源账户"]')!;
  await act(() => selector.click());
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(host.querySelector('[role="option"]')?.textContent).toContain(source.email);
  await act(() => selector.click());
  await click('预览迁移');
  expect(previewAccountImport).toHaveBeenCalledWith(source);
  expect(host.textContent).toContain('附件需要单独迁移');
  await click('导入这 2 条');
  expect(importAccount).toHaveBeenCalledWith(source, { skipExisting: true });
});
it('blocks transfers while a bulk deletion preview is awaiting confirmation', async () => {
  const account = { serverUrl: 'https://target.example', email: 'target@example.com', userId: 'target', kdf: { kdf: 0 as const, iterations: 1 } };
  const snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked' as const, account };
  const commitBulkDelete = vi.fn(async () => ({ completed: 2, skipped: 0, failed: [] }));
  const { host, click } = await mount({ getSnapshot: () => snapshot, commitBulkDelete,
    previewBulkDelete: async () => ({ token: 'confirmed-target', scope: 'vault', count: 2, account }) });
  await click('预览移到回收站');
  expect(host.querySelector('[role="tabpanel"]')?.hasAttribute('inert')).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('#transfer-tab-export')?.disabled).toBe(true);
  expect(commitBulkDelete).not.toHaveBeenCalled();
  await click('确认移到回收站');
  expect(commitBulkDelete).toHaveBeenCalledWith('confirmed-target');
  expect(host.querySelector('[role="tabpanel"]')?.hasAttribute('inert')).toBe(false);
});
it('defaults export to encrypted JSON, validates confirmation, and distinguishes save cancellation', async () => {
  const exportVault = vi.fn(async () => ({ fileName: 'encrypted.json', dataBase64: 'YWJj', itemCount: 2, folderCount: 1, warnings: [] }));
  const saveFile = vi.fn(async () => ({ path: null }));
  const { host, click } = await mount({ exportVault, saveFile });
  await click('导出');
  expect(host.textContent).toContain('加密 JSON');
  await act(() => { input(host, '导出密码', 'long-test-password'); input(host, '确认导出密码', 'different'); });
  await click('导出文件');
  expect(exportVault).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/不一致/);
  await act(() => input(host, '确认导出密码', 'long-test-password'));
  await click('导出文件');
  expect(exportVault).toHaveBeenCalledWith({ format: 'encrypted-json', password: 'long-test-password' });
  expect(saveFile).toHaveBeenCalledWith('encrypted.json', 'YWJj');
  expect(host.textContent).toContain('已取消保存');
  expect(host.querySelector<HTMLInputElement>('input[aria-label="导出密码"]')!.value).toBe('');
});
it('opens a dropped encrypted file in import and retries its password before allowing import', async () => {
  const parseImport = vi.fn(async (file) => file.password === 'correct'
    ? { fileName: file.name, format: 'bitwarden-json' as const, formatLabel: 'JSON', total: 1, byType: { login: 1 }, folders: 0, skipped: [] }
    : file.password ? Promise.reject(new Error('导出密码不正确'))
    : { fileName: file.name, format: 'bitwarden-json' as const, formatLabel: 'JSON', total: 0, byType: {}, folders: 0, skipped: [], needsPassword: true });
  const importData = vi.fn();
  const { host, click } = await mount({ parseImport, importData }, { droppedFile: { name: 'encrypted.json', dataBase64: 'YWJj' } });
  expect(host.textContent).toContain('文件解密密码');
  await act(() => input(host, '文件解密密码', 'wrong')); await click('解密并预览');
  expect(host.textContent).toContain('导出密码不正确');
  await act(() => input(host, '文件解密密码', 'correct')); await click('解密并预览');
  expect(host.textContent).toContain('encrypted.json');
  expect(importData).not.toHaveBeenCalled();
});
it('does not save a late export after the page closes', async () => {
  let finish!: (value: ExportFile) => void;
  const saveFile = vi.fn();
  const { host, root, click } = await mount({ exportVault: () => new Promise(resolve => { finish = resolve; }), saveFile });
  await click('导出');
  await act(() => { input(host, '导出密码', 'long-test-password'); input(host, '确认导出密码', 'long-test-password'); });
  await click('导出文件');
  await act(() => root.render(null));
  await act(() => finish({ fileName: 'backup.json', dataBase64: 'secret', itemCount: 1, folderCount: 0, warnings: [] }));
  expect(saveFile).not.toHaveBeenCalled();
});
it('shows an unsupported dropped-file error without writing any records', async () => {
  const importData = vi.fn();
  const { host } = await mount({ importData, parseImport: async file => ({ fileName: file.name, format: 'auto',
    formatLabel: '自动识别', total: 0, byType: {}, folders: 0, skipped: [{ rowNumber: 1, reason: '不支持这个文件格式' }] }) },
  { droppedFile: { name: 'image.png', dataBase64: 'iVBORw==' } });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('不支持这个文件格式');
  expect(importData).not.toHaveBeenCalled();
});
it('never opens a save dialog after the account locks while encryption is running', async () => {
  let finish!: (value: ExportFile) => void;
  let changed = () => {};
  let snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked' as const } as import('../application/types').ApplicationSnapshot;
  const saveFile = vi.fn();
  const { host, click } = await mount({
    getSnapshot: () => snapshot, subscribe: callback => { changed = callback; return () => {}; },
    exportVault: () => new Promise(resolve => { finish = resolve; }), saveFile,
  });
  await click('导出');
  await act(() => { input(host, '导出密码', 'long-test-password'); input(host, '确认导出密码', 'long-test-password'); });
  await click('导出文件');
  await act(() => { snapshot = { ...snapshot, status: 'locked' }; changed(); });
  await act(() => finish({ fileName: 'backup.json', dataBase64: 'secret', itemCount: 1, folderCount: 0, warnings: [] }));
  expect(saveFile).not.toHaveBeenCalled();
});
