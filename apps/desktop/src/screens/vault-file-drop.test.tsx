// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultClient } from '@1warden/vault';
import { createVaultService } from '../application/service';
import { createApplicationClient } from '../application/client';
import { ToastProvider } from '../components/Toast';
import { VaultView } from './VaultView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
async function mount() {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const vault = new VaultClient({ fetchImpl: async () => { throw new Error('Test must not write to a server'); } });
  vault.restore({ account: { email: 'fixture@example.invalid', serverUrl: 'https://fixture.invalid', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: null, items: [], folders: [], syncVerified: true });
  const client = createApplicationClient({ ...createVaultService(vault), sync: async () => {} }, {
    capabilities: { native: false, browser: false, saveAttachments: true }, saveFile: async () => ({ path: null }),
  });
  await client.initialize();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(() => root.render(createElement(StrictMode, null, createElement(ToastProvider, null, createElement(VaultView, { client, onLock: () => {} })))));
  cleanups.push(async () => { await act(() => root.unmount()); client.dispose(); host.remove(); });
  return { host, vault };
}
async function drop(name: string, content: string) {
  const file = new File([content], name); Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'], items: [{ kind: 'file' }] } });
  await act(async () => { document.body.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
}
const json = JSON.stringify({ encrypted: false, items: [{ name: 'Dropped synthetic item', type: 1, login: { username: 'fixture', password: 'synthetic-secret' } }] });
it('opens the unified import preview from a window-wide drop without writing records', async () => {
  const { host, vault } = await mount();
  await drop('backup.json', json);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('导入');
  expect(host.textContent).toContain('backup.json');
  expect(host.textContent).not.toContain('synthetic-secret');
  expect(vault.getSession().items).toEqual([]);
  await act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === '导出')!.click());
  await drop('unsupported.bin', 'arbitrary binary without a supported header');
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('导入');
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/认不出|不支持/);
  expect(vault.getSession().items).toEqual([]);
});
it('keeps an open item editor intact when a file is dropped', async () => {
  const { host, vault } = await mount();
  const newItem = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.title.startsWith('新建条目'))!;
  expect(newItem).toBeTruthy(); await act(() => newItem.click());
  const editor = document.querySelector('[role="dialog"]'); expect(editor).toBeTruthy();
  await drop('backup.json', json);
  expect(document.querySelector('[role="dialog"]')).toBe(editor);
  expect(document.body.textContent).toMatch(/先完成当前编辑/);
  expect(host.querySelector('[role="tablist"][aria-label="数据迁移"]')).toBeNull();
  expect(vault.getSession().items).toEqual([]);
});
