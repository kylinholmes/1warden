// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { buildReport, emptyLogin, VaultClient } from '@1warden/vault';
import { reportBrief } from '@1warden/ui';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { createVaultService } from '../application/service';
import { createApplicationClient } from '../application/client';
import { ToastProvider } from '../components/Toast';
import { VaultView } from './VaultView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it.each([false, true])('keeps full-width report context through detail, edit/save and back (compact=%s)', async compact => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: compact, addEventListener() {}, removeEventListener() {} }) });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const vault = new VaultClient({ fetchImpl: async () => { throw new Error('No real network allowed'); } });
  const items = Array.from({ length: 10 }, (_, index) => ({ ...blankEditorItem(), id: `fixture-${index}`, name: `Fixture ${index}`,
    login: { ...emptyLogin(), password: `Synthetic!qZ${index}#long-value` }, updatedAt: '2026-01-01' }));
  vault.restore({ account: { email: 'fixture@example.invalid', serverUrl: 'https://fixture.invalid', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: null, items, folders: [], syncVerified: true });
  const save = vi.spyOn(vault, 'saveItem').mockImplementation(async draft => {
    const saved = { ...draft, updatedAt: '2026-02-01' };
    vault.getSession().replaceData(vault.getSession().items.map(item => item.id === saved.id ? saved : item), []);
    return saved;
  });
  const service = createVaultService(vault);
  const checkBreaches = vi.fn(async (now: number) => reportBrief(buildReport(vault.getSession().items, now,
    [{ itemId: 'fixture-0', count: 42 }]), item => item.name));
  const client = createApplicationClient({ ...service, checkBreaches, sync: async () => {} }, {
    capabilities: { native: false, browser: false, saveAttachments: true }, saveFile: async () => ({ path: null }),
  });
  await client.initialize();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  cleanups.push(async () => { await act(() => root.unmount()); client.dispose(); host.remove(); });
  await act(() => root.render(createElement(ToastProvider, null, createElement(VaultView, { client, onLock: () => {} }))));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
  await act(async () => button('安全报告').click());
  expect(checkBreaches).not.toHaveBeenCalled();
  await act(async () => button('开启检查').click());
  const scroll = host.querySelector<HTMLElement>('[data-security-report-scroll]')!; scroll.scrollTop = 300;
  const opener = host.querySelector<HTMLButtonElement>('button[aria-label="查看「Fixture 0」"]')!;
  opener.focus(); await act(async () => opener.click());
  expect(host.querySelector('.vault-content')).toBeNull();
  expect(host.querySelector('article h2')?.textContent).toBe('Fixture 0');
  expect(host.querySelector('button[aria-label="返回安全报告"]')?.classList.contains('detail-back')).toBe(false);
  await act(async () => button('编辑').click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="密码"]')?.type).toBe('password');
  const name = dialog.querySelector<HTMLInputElement>('input[aria-label="名称"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Renamed fixture');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '保存')!.click());
  expect(save).toHaveBeenCalledOnce();
  expect(host.querySelector('.vault-content')).toBeNull();
  expect(host.querySelector('article h2')?.textContent).toBe('Renamed fixture');
  expect(checkBreaches).toHaveBeenCalledTimes(2);
  await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="返回安全报告"]')!.click());
  expect(host.querySelector('[data-security-report-scroll]')).toBe(scroll);
  expect(scroll.scrollTop).toBe(300);
  expect(host.querySelector('[aria-label="安全评分 70 分，满分 100 分"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="查看「Renamed fixture」"]')).not.toBeNull();
  expect(host.textContent).not.toContain('Synthetic!');
});
