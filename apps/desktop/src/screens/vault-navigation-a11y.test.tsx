// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { SORT_BY, SORT_LABEL, emptyCard, emptyLogin, VaultClient, type VaultItem } from '@1warden/vault';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { createVaultService } from '../application/service';
import { createApplicationClient } from '../application/client';
import { ToastProvider } from '../components/Toast';
import { VaultView } from './VaultView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
const fixture = (overrides: Partial<VaultItem> = {}): VaultItem => ({ ...blankEditorItem(), id: 'fixture', name: 'Synthetic login', updatedAt: '2026-01-01', ...overrides });
const folders = [{ id: 'empty-folder', name: 'Synthetic folder', nameFailed: false, updatedAt: '2026-01-01' }];
async function mount(items = [fixture()], compact = false) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: compact, addEventListener() {}, removeEventListener() {} }) });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const vault = new VaultClient({ fetchImpl: async () => { throw new Error('No real network allowed'); } });
  vault.restore({ account: { email: 'fixture@example.invalid', serverUrl: 'https://fixture.invalid', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: null, items, folders, syncVerified: true });
  const save = vi.spyOn(vault, 'saveItem').mockImplementation(async draft => {
    const saved = { ...draft, id: 'saved-fixture', updatedAt: '2026-02-01' };
    vault.getSession().replaceData([...vault.getSession().items, saved], folders); return saved;
  });
  const service = createVaultService(vault);
  const client = createApplicationClient({ ...service, sync: async () => {} }, {
    capabilities: { native: false, browser: false, saveAttachments: true }, saveFile: async () => ({ path: null }),
  });
  await client.initialize();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  cleanups.push(async () => { await act(() => root.unmount()); client.dispose(); host.remove(); });
  await act(() => root.render(createElement(ToastProvider, null, createElement(VaultView, { client, onLock: () => {} }))));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
  return { host, vault, client, save, button };
}
async function key(element: HTMLElement, key: string) {
  await act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
}
async function value(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('uses the shared sorting keyboard contract and exposes persisted current choice', async () => {
  const { host } = await mount(); const sort = host.querySelector<HTMLButtonElement>('[role=combobox][aria-label="排序方式"]')!;
  await act(() => sort.focus()); await key(sort, 'ArrowDown');
  expect(host.querySelector('[role=option][aria-selected=true]')?.textContent).toBe(SORT_LABEL[SORT_BY.updated]);
  await key(sort, 'End'); await key(sort, 'Enter');
  expect(sort.textContent).toBe(SORT_LABEL[SORT_BY.name]); expect(localStorage.getItem('1warden.pref.sortBy')).toBe(SORT_BY.name);
  expect(document.activeElement).toBe(sort); await key(sort, 'ArrowUp'); await key(sort, 'Home'); await key(sort, 'Escape');
  expect(sort.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(sort);
  expect(sort.textContent).toBe(SORT_LABEL[SORT_BY.name]);
});
it.each(['', 'Synthetic'])('retains selected detail during sync with query "%s" and refreshes a changed record', async query => {
  const original = fixture({ login: { ...emptyLogin(), password: 'Synthetic detail secret' } });
  const { host, vault, client } = await mount([original]);
  const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索条目"]')!;
  if (query) { await value(input, query); await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); }); }
  const getItem = vi.spyOn(client, 'getItem');
  await act(() => host.querySelector<HTMLButtonElement>('.vault-list ul > li > button')!.click());
  const article = host.querySelector('.item-detail'); expect(article).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="显示密码"]')!.click());
  const hide = host.querySelector<HTMLButtonElement>('[aria-label="隐藏密码"]')!; hide.focus();
  if (query) vi.spyOn(client, 'search').mockImplementation(() => new Promise(() => {}));
  getItem.mockClear();
  await act(async () => { vault.getSession().setSyncing(true); await client.refresh(); });
  expect(host.querySelector('.item-detail')).toBe(article);
  await act(async () => { vault.getSession().setSyncing(false); await client.refresh(); });
  expect(host.querySelector('.item-detail')).toBe(article);
  expect(getItem).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(hide);
  expect(article!.textContent).toContain('Synthetic detail secret');
  await act(async () => {
    vault.getSession().replaceData([{ ...original, name: 'Updated record', updatedAt: '2026-02-01' }], folders);
    await client.refresh();
  });
  expect(host.querySelector('.item-detail')).not.toBe(article);
  expect(host.querySelector('.item-detail')?.textContent).toContain('Updated record');
  expect(host.querySelector('.item-detail')?.textContent).not.toContain('Synthetic detail secret');
  expect(getItem).toHaveBeenCalledTimes(1);
  // The server's partial favorite endpoint does not return a revision date.
  await act(async () => {
    vault.getSession().replaceData([{ ...original, name: 'Updated record', updatedAt: '2026-02-01', favorite: true }], folders);
    await client.refresh();
  });
  expect(host.querySelector('[aria-label="取消收藏"]')).not.toBeNull();
  if (query) {
    await act(async () => { vault.getSession().replaceData([], folders); await client.refresh(); });
    expect(host.querySelector('.item-detail')).toBeNull();
    expect(host.querySelector('.vault-list ul > li > button')).toBeNull();
    await value(input, 'Different query');
    expect(host.querySelector('.vault-list')?.textContent).not.toContain('Updated record');
  }
});
it.each([false, true])('exposes current item and favorite within ordinary list/button navigation (compact=%s)', async compact => {
  const { host } = await mount([fixture({ favorite: true }), fixture({ id: 'other', name: 'Other login' })], compact);
  const rows = [...host.querySelectorAll<HTMLButtonElement>('.vault-list ul > li > button')];
  const row = rows.find(row => row.textContent?.includes('Synthetic login'))!;
  expect(row.textContent).toContain('已收藏'); expect(row.getAttribute('aria-current')).toBeNull();
  await act(() => row.click()); expect(row.getAttribute('aria-current')).toBe('true');
  expect(host.querySelector('[role=listbox]')).toBeNull(); expect(host.querySelectorAll('main')).toHaveLength(1);
  expect(host.querySelector('main > h1')?.textContent).toBe('保险库');
});
it('creates into the selected empty folder and keeps the saved record discoverable there', async () => {
  const { host, button, save } = await mount();
  await act(() => button('Synthetic folder').click()); expect(host.textContent).toContain('这个文件夹还是空的');
  await act(() => button('在此文件夹新建条目').click());
  const dialog = host.querySelector('[role=dialog][aria-modal=true]')!;
  await value(dialog.querySelector<HTMLInputElement>('input[aria-label="名称"]')!, 'Created in folder');
  await act(() => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click());
  expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]![0].folderId).toBe('empty-folder');
  expect(host.querySelector('.vault-list [aria-current=true]')?.textContent).toContain('Created in folder');
  expect(button('Synthetic folder').getAttribute('aria-current')).toBe('page');
});
it('offers a favorites browse action and clears failed search without leaving its folder category', async () => {
  const { host, button, client } = await mount();
  await act(() => button('收藏0').click());
  expect(host.textContent).toContain('还没有收藏条目'); await act(() => button('浏览全部条目').click());
  expect(host.querySelector('.vault-list')?.textContent).toContain('Synthetic login');
  await act(() => button('Synthetic folder').click());
  vi.spyOn(client, 'search').mockResolvedValue([]);
  const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索条目"]')!;
  await value(input, 'missing'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)); });
  expect(host.textContent).toContain('没有匹配「missing」的条目');
  await act(() => button('清除搜索').click()); expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
  expect(host.textContent).toContain('这个文件夹还是空的'); expect(button('Synthetic folder').getAttribute('aria-current')).toBe('page');
});
it('connects empty vault import action to a destination main/h1', async () => {
  const { host, button } = await mount([]);
  expect(button('新建条目')).toBeDefined(); await act(() => button('导入条目').click());
  expect(host.querySelectorAll('main')).toHaveLength(1); expect(host.querySelector('main h1')?.textContent).toBe('导入 / 导出');
  expect(host.querySelector('main main')).toBeNull(); await act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回保险库"]')!.click());
  expect(host.querySelector('main h1')?.textContent).toBe('保险库');
});

it('opens a new favorite from favorites navigation with the favorite already set', async () => {
  const { host, button, save } = await mount(); await act(() => button('收藏0').click());
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="新建条目"]')!.click());
  const dialog = host.querySelector('[role=dialog][aria-modal=true]')!;
  expect(dialog.querySelector('button[aria-pressed=true][title="取消收藏"]')).not.toBeNull();
  await value(dialog.querySelector<HTMLInputElement>('input[aria-label="名称"]')!, 'New favorite');
  await act(() => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click());
  expect(save.mock.calls[0]![0].favorite).toBe(true);
  expect(host.querySelector('.vault-list [aria-current=true]')?.textContent).toContain('New favorite');
});
it('keeps an emptied type category functional and creates the matching native type', async () => {
  const { host, vault, client, button, save } = await mount([fixture({ type: 'card', rawType: 3, login: null, card: emptyCard() })]);
  const type = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '信用卡1')!;
  await act(() => type.click()); await act(async () => { vault.getSession().replaceData([], folders); await client.sync(); });
  expect(host.textContent).toContain('还没有信用卡条目');
  await act(() => button('新建条目').click());
  const dialog = host.querySelector('[role=dialog][aria-modal=true]')!;
  await value(dialog.querySelector<HTMLInputElement>('input[aria-label="名称"]')!, 'New typed card');
  await act(() => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click());
  expect(save.mock.calls[0]![0].type).toBe('card'); expect(save.mock.calls[0]![0].card).not.toBeNull();
  expect(save.mock.calls[0]![0].rawType).toBe(3); expect(save.mock.calls[0]![0].login).toBeNull();
});
