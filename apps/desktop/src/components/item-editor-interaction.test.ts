// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ItemEditor } from '../../../../packages/ui/src/ItemEditor';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import type { VaultItem } from '@1warden/vault';

let root: Root;
let host: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); });
function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(node: HTMLElement) { await act(() => node.click()); }
async function input(node: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(item: VaultItem | null, onSave = async (draft: VaultItem) => ({ id: 'saved', name: draft.name }), extra: Partial<ComponentProps<typeof ItemEditor>> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(createElement(ItemEditor, { folders: [], item, open: true, onSave, onDone: () => {}, onCancel: () => {}, ...extra })));
}

describe('Add More editor interactions', () => {
  it('adds the selected native field, focuses it, keeps it visible while cleared and saves untouched data', async () => {
    const item = { ...blankEditorItem(), name: 'Saved', notes: '', customFields: [{ name: 'flag', value: 'false', type: 2 as const, linkedId: null }] };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelector('[aria-label="密码"]')).toBeNull();
    expect(host.querySelector('[aria-label="备注"]')).toBeNull();
    await click(button('添加更多'));
    await click(button('密码'));
    const password = host.querySelector<HTMLInputElement>('[aria-label="密码"]')!;
    expect(password).not.toBeNull();
    expect(document.activeElement).toBe(password);
    await input(password, 'abc123'); await input(password, '');
    expect(host.querySelector('[aria-label="密码"]')).toBe(password);
    await click(button('添加更多'));
    expect(host.querySelector('[role="menuitem"][data-add-field="login.password"]')).toBeNull();
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(button('添加更多')).toBe(document.activeElement);
    await click(button('保存'));
    expect(saved?.notes).toBe('');
    expect(saved?.login?.password).toBe('');
    expect(saved?.customFields).toEqual(item.customFields);
    await act(() => root.unmount()); host.remove();
    await mount(saved!);
    expect(host.querySelector('[aria-label="密码"]')).toBeNull();
  });
  it('adds repeated URLs only through Add More and restores explicit removal before save', async () => {
    const item = { ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, uris: [{ uri: 'https://one.example', match: 5, sourceId: 'one' }] } };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    await click(button('添加更多')); await click(button('网址'));
    const second = host.querySelector<HTMLInputElement>('[aria-label="网址 2"]')!;
    expect(document.activeElement).toBe(second);
    await input(second, 'https://two.example');
    await click(host.querySelector<HTMLButtonElement>('[aria-label="删除网址 1"]')!);
    await click(button('撤销移除'));
    expect(host.querySelector<HTMLInputElement>('[aria-label="网址 1"]')?.value).toBe('https://one.example');
    await click(button('保存'));
    expect(saved?.login?.uris).toEqual([{ uri: 'https://one.example', match: 5, sourceId: 'one' }, { uri: 'https://two.example', match: null }]);
  });
  it('starts a new login with one website placeholder and omits it on save', async () => {
    let saved: VaultItem | undefined;
    await mount(null, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelectorAll('[aria-label="网址 1"]').length).toBe(1);
    expect(host.querySelector('[aria-label="验证码"]')).toBeNull();
    expect(host.querySelector('[aria-label="备注"]')).toBeNull();
    await input(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!, 'New');
    await click(button('保存'));
    expect(saved?.login?.uris).toEqual([]);
  });
  it('undo preserves later typing in unrelated fields and restores removed native data', async () => {
    const item = { ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, username: 'alice', password: 'secret' } };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="移除密码"]')!);
    await input(host.querySelector<HTMLInputElement>('[aria-label="用户名"]')!, 'bob');
    await click(button('撤销移除')); await click(button('保存'));
    expect(saved?.login?.username).toBe('bob');
    expect(saved?.login?.password).toBe('secret');
  });
  it('returns focus to Add More after removing the focused native control', async () => {
    await mount({ ...blankEditorItem(), name: 'Login', notes: 'memo' });
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="移除备注"]')!;
    remove.focus(); await click(remove);
    expect(document.activeElement).toBe(button('添加更多'));
  });
  it('creates and selects a folder while staging assignment until item Save', async () => {
    let saved: VaultItem | undefined;
    let requestedName = '';
    await mount({ ...blankEditorItem(), name: 'Login' }, async draft => {
      saved = draft; return { id: 'saved', name: draft.name };
    }, { onCreateFolder: async name => { requestedName = name; return { id: 'new-folder', name }; } });
    await input(host.querySelector<HTMLInputElement>('[aria-label="新文件夹名称"]')!, '  Work  ');
    await click(button('创建文件夹'));
    expect(requestedName).toBe('Work');
    expect(saved).toBeUndefined();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="文件夹"]')?.value).toBe('new-folder');
    await click(button('保存'));
    expect(saved?.folderId).toBe('new-folder');
  });
  it('does not offer a cached created folder after a later session removes it', async () => {
    const item = { ...blankEditorItem(), name: 'Login' };
    const callbacks = { onSave: async (draft: VaultItem) => ({ id: 'saved', name: draft.name }),
      onDone: () => {}, onCancel: () => {}, onCreateFolder: async (name: string) => ({ id: 'removed-later', name }) };
    await mount(item, callbacks.onSave, callbacks);
    await input(host.querySelector<HTMLInputElement>('[aria-label="新文件夹名称"]')!, 'Temporary');
    await click(button('创建文件夹'));
    expect(host.querySelector('option[value="removed-later"]')).not.toBeNull();
    await act(() => root.render(createElement(ItemEditor, { folders: [], item, open: false, ...callbacks })));
    await act(() => root.render(createElement(ItemEditor, { folders: [], item, open: true, ...callbacks })));
    expect(host.querySelector('option[value="removed-later"]')).toBeNull();
  });
  it('creates the selected boolean row directly and removes the old parallel add entrances', async () => {
    await mount({ ...blankEditorItem(), name: 'Login' });
    await click(button('添加更多')); await click(button('自定义 · 开关'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="字段 1 类型"]')?.value).toBe('2');
    expect(host.querySelector<HTMLInputElement>('[aria-label="字段 1 开关"]')?.checked).toBe(false);
    expect([...host.querySelectorAll('button')].some(node => ['添加网址', '添加字段'].includes(node.textContent?.trim() ?? ''))).toBe(false);
  });
});
