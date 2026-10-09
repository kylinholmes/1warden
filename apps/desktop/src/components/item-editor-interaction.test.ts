// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemEditor } from '../../../../packages/ui/src/ItemEditor';
import { blankCard, blankEditorItem, nativeEditorFields, nativeFieldValue } from '../../../../packages/ui/src/item-editor-fields';
import { TYPE_LABEL, TYPE_ORDER } from '../../../../packages/ui/src/destinations';
import type { VaultItem } from '@1warden/vault';
import { emptyPassport } from '@1warden/vault';

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

describe('complete native editor and custom-field interactions', () => {
  it('locks every draft control during a slow save and ignores same-tick duplicate submissions', async () => {
    let resolve!: (value: { id: string; name: string }) => void;
    const onSave = vi.fn(() => new Promise<{ id: string; name: string }>(done => { resolve = done; }));
    const onDone = vi.fn();
    await mount(null, onSave, { onDone, onCreateFolder: async name => ({ id: 'folder', name }) });
    await input(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!, 'Kept');
    const save = button('保存');
    await act(() => { save.click(); save.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    const controls = [...host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select,button')];
    expect(controls.length).toBeGreaterThan(15);
    expect(controls.every(control => control.matches(':disabled') || control.closest('[inert]'))).toBe(true);
    // Even a queued input event cannot mutate the draft already being persisted.
    await input(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!, 'Too late');
    expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe('Kept');
    await act(() => resolve({ id: 'saved', name: 'Kept' }));
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ id: 'saved', name: 'Kept' });
  });
  it('restores editing and focus after a failed save without dropping the draft', async () => {
    let reject!: (reason: Error) => void;
    const onSave = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockImplementationOnce(async (draft: VaultItem) => ({ id: 'saved', name: draft.name }));
    const onDone = vi.fn();
    await mount({ ...blankEditorItem(), name: 'Original' }, onSave, { onDone });
    const name = host.querySelector<HTMLInputElement>('[aria-label="名称"]')!;
    await input(name, 'Draft');
    const save = button('保存'); save.focus();
    await click(save);
    const failure = '服务器未能保存此条目。请检查网络连接后重试；你输入的名称、密码和备注均已保留。'.repeat(3);
    await act(() => reject(new Error(failure)));
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe(failure);
    expect(alert.classList.contains('truncate')).toBe(false);
    expect(alert.classList.contains('break-words')).toBe(true);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(name.matches(':disabled')).toBe(false);
    expect(name.closest('[inert]')).toBeNull();
    expect(name.value).toBe('Draft');
    expect(document.activeElement).toBe(save);
    expect(onDone).not.toHaveBeenCalled();
    await input(name, 'Retry'); await click(button('保存'));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ id: 'saved', name: 'Retry' });
  });
  it('shows all fixed fields immediately, keeps cleared fields mounted and saves untouched data', async () => {
    const item = { ...blankEditorItem(), name: 'Saved', notes: '', customFields: [{ name: 'flag', value: 'false', type: 2 as const, linkedId: null }] };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelector('[aria-label="密码"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="备注"]')).not.toBeNull();
    const password = host.querySelector<HTMLInputElement>('[aria-label="密码"]')!;
    expect(password).not.toBeNull();
    await input(password, 'abc123'); await input(password, '');
    expect(host.querySelector('[aria-label="密码"]')).toBe(password);
    await click(button('添加自定义字段'));
    expect(host.querySelector('[data-add-field]')).toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(node => node.dataset.addCustom)).toEqual(['0', '1', '2', '3']);
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(button('添加自定义字段')).toBe(document.activeElement);
    await click(button('保存'));
    expect(saved?.notes).toBe('');
    expect(saved?.login?.password).toBe('');
    expect(saved?.customFields).toEqual(item.customFields);
    await act(() => root.unmount()); host.remove();
    await mount(saved!);
    expect(host.querySelector<HTMLInputElement>('[aria-label="密码"]')?.value).toBe('');
  });
  it('adds repeated URLs in their section and restores explicit removal before save', async () => {
    const item = { ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, uris: [{ uri: 'https://one.example', match: 5, sourceId: 'one' }] } };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelector('[data-editor-field="login.uris"] [data-editor-add-url]')).not.toBeNull();
    await click(button('添加网址'));
    const second = host.querySelector<HTMLInputElement>('[aria-label="网址 2"]')!;
    expect(document.activeElement).toBe(second);
    await input(second, 'https://two.example');
    await click(host.querySelector<HTMLButtonElement>('[aria-label="删除网址 1"]')!);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="网址 1"]'));
    await click(button('撤销移除'));
    expect(host.querySelector<HTMLInputElement>('[aria-label="网址 1"]')?.value).toBe('https://one.example');
    expect(document.activeElement).toBe(host.querySelector('[aria-label="网址 1"]'));
    await click(button('保存'));
    expect(saved?.login?.uris).toEqual([{ uri: 'https://one.example', match: 5, sourceId: 'one' }, { uri: 'https://two.example', match: null }]);
  });
  it.each(TYPE_ORDER)('shows every fixed field when creating a %s record', async type => {
    await mount(null);
    await click(button(TYPE_LABEL[type]!));
    expect([...host.querySelectorAll<HTMLElement>('[data-editor-field]')].map(node => node.dataset.editorField))
      .toEqual(nativeEditorFields(type).map(field => field.id));
    expect(host.querySelector('[aria-label^="移除"]')).toBeNull();
    expect(host.querySelectorAll('[data-editor-add-more]')).toHaveLength(1);
  });
  it.each(TYPE_ORDER)('shows every fixed field while editing an empty %s record', async type => {
    await mount({ ...blankEditorItem(), type, name: 'Empty record' });
    expect([...host.querySelectorAll<HTMLElement>('[data-editor-field]')].map(node => node.dataset.editorField))
      .toEqual(nativeEditorFields(type).map(field => field.id));
    expect(host.querySelector('[aria-label^="移除"]')).toBeNull();
  });
  it.each(['identity', 'driversLicense', 'passport'] as const)('saves %s compound name inputs to their distinct native fields', async type => {
    let saved: VaultItem | undefined;
    await mount({ ...blankEditorItem(), type, name: 'Document' }, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    const name = nativeEditorFields(type).find(field => field.id === `${type}.name`)!;
    const controls = host.querySelectorAll<HTMLInputElement>(`[data-editor-field="${type}.name"] input`);
    expect(controls).toHaveLength(name.keys.length);
    for (const control of controls) {
      expect(control.closest('label')?.classList.contains('flex')).toBe(true);
      expect(control.closest('label')?.classList.contains('flex-col')).toBe(true);
      expect(control.closest('label')?.querySelector('[data-field-label]')?.className).toContain('text-[var(--violet)]');
    }
    for (let index = 0; index < controls.length; index++) await input(controls[index]!, `Name ${index}`);
    await click(button('保存'));
    expect(saved).toBeDefined();
    name.keys.forEach((key, index) => expect(nativeFieldValue(saved!, key)).toBe(`Name ${index}`));
    expect(nativeFieldValue(saved!, `${type}.name`)).toBeUndefined();
  });
  it('keeps notes accessible with one visible heading and no reserved label column', async () => {
    await mount({ ...blankEditorItem(), type: 'secureNote', name: 'Notes', notes: 'Kept notes' });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="备注"]')!;
    expect(textarea.value).toBe('Kept notes');
    expect([...host.querySelectorAll('h3')].filter(node => node.textContent === '备注')).toHaveLength(1);
    const row = textarea.closest('[data-editor-field="notes"]')!;
    expect(row.querySelector('span')).toBeNull();
    expect(row.textContent?.trim()).toBe('Kept notes');
  });
  it('keeps labels above inputs and puts one divider on each responsive compound group', async () => {
    await mount({ ...blankEditorItem(), type: 'identity', name: 'Identity' });
    const ordinary = host.querySelector<HTMLElement>('[data-editor-field="identity.title"]')!;
    const ordinaryLabel = ordinary.querySelector<HTMLElement>(':scope > [data-field-label]')!;
    const cells = [...host.querySelectorAll<HTMLElement>('[data-compound-cells] > label')];
    expect(cells).toHaveLength(5);
    for (const group of host.querySelectorAll<HTMLElement>('[data-compound-field]')) {
      expect(group.style.gridTemplateColumns).toBe('');
      expect(group.classList.contains('grid')).toBe(false);
      expect(group.classList.contains('@container')).toBe(true);
      expect(group.classList.contains('py-2')).toBe(true);
      expect(group.classList.contains('border-b')).toBe(true);
      expect(group.classList.contains('[&:not(:last-child)>:last-child]:border-b')).toBe(false);
      const grid = group.querySelector<HTMLElement>(':scope > [data-compound-cells]')!;
      expect(grid.classList.contains('grid-cols-1')).toBe(true);
      expect(grid.classList.contains(grid.children.length === 3 ? '@[360px]:grid-cols-3' : '@[240px]:grid-cols-2')).toBe(true);
    }
    for (const row of [ordinary, ...cells]) {
      expect(row.classList.contains('flex-col')).toBe(true);
      expect(row.classList.contains('gap-1')).toBe(true);
      expect(row.classList.contains('py-2')).toBe(row === ordinary);
      expect(row.classList.contains('py-3')).toBe(false);
      expect(row.classList.contains('border-b')).toBe(row === ordinary);
      expect(row.querySelector(':scope > [data-field-value]')?.classList.contains('w-full')).toBe(true);
    }
    for (const label of [ordinaryLabel, ...cells.map(cell => cell.querySelector<HTMLElement>('span')!)]) {
      expect(label.classList.contains('w-[76px]')).toBe(false);
      expect(label.classList.contains('shrink-0')).toBe(false);
      expect(label.classList.contains('text-xs')).toBe(true);
      expect(label.classList.contains('pt-[9px]')).toBe(false);
    }
    for (const cell of cells) {
      const input = cell.querySelector('input')!;
      expect(input.classList.contains('min-w-0')).toBe(true);
      expect(input.classList.contains('w-full')).toBe(true);
    }
  });
  it('lets password strength feedback wrap below a narrow credential without losing the generate action', async () => {
    await mount({ ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, password: 'Synthetic password' } });
    const password = host.querySelector<HTMLElement>('[data-editor-field="login.password"]')!;
    const meter = password.querySelector<HTMLElement>('[aria-hidden]')!.parentElement!;
    expect(meter.classList.contains('flex-wrap')).toBe(true);
    const generate = password.querySelector<HTMLButtonElement>('[title="生成随机密码"]')!;
    await click(generate);
    expect(host.querySelector<HTMLInputElement>('[aria-label="密码"]')!.value).toHaveLength(20);
  });
  it.each(TYPE_ORDER)('uses label-above-value markup consistently for all %s native fields', async type => {
    await mount({ ...blankEditorItem(), type, name: 'Single-column template' });
    const rows = [...host.querySelectorAll<HTMLElement>('[data-editor-field]:not([data-compound-field]), [data-compound-cells] > label')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.classList.contains('flex-col')).toBe(true);
      const label = row.querySelector<HTMLElement>(':scope > [data-field-label]');
      const content = row.querySelector<HTMLElement>(':scope > [data-field-value]')!;
      expect(content).not.toBeNull();
      expect(content.classList.contains('w-full')).toBe(true);
      if (['notes', 'login.uris'].includes(row.dataset.editorField ?? '')) expect(label).toBeNull();
      else {
        expect(label).not.toBeNull();
        expect(label!.nextElementSibling).toBe(content);
        expect(label!.classList.contains('text-xs')).toBe(true);
        expect(label!.classList.contains('w-[76px]')).toBe(false);
        expect(label!.classList.contains('shrink-0')).toBe(false);
      }
    }
  });
  it('retains empty name/region inputs and preserves input focus while updating compound values', async () => {
    await mount({ ...blankEditorItem(), type: 'identity', name: 'Empty grouped fields' });
    const name = host.querySelector('[data-compound-field="identity.name"]')!;
    const region = host.querySelector('[data-compound-field="identity.region"]')!;
    expect(name.querySelector('[data-compound-cells]')?.children).toHaveLength(3);
    expect(region.querySelector('[data-compound-cells]')?.children).toHaveLength(2);
    const given = name.querySelector<HTMLInputElement>('[aria-label="名"]')!;
    given.focus();
    await input(given, 'Given name');
    expect(document.activeElement).toBe(given);
    await input(given, '');
    expect(document.activeElement).toBe(given);
    expect(name.querySelector('[data-compound-cells]')?.children).toHaveLength(3);
    expect(region.querySelector('[data-compound-cells]')?.children).toHaveLength(2);
    expect([...name.querySelectorAll<HTMLInputElement>('input')].every(control => control.value === '')).toBe(true);
  });
  it('lets each URL own its visible label without adding a duplicate outer URL label', async () => {
    await mount({ ...blankEditorItem(), name: 'URL labels', login: { ...blankEditorItem().login!,
      uris: [{ uri: 'https://example.invalid', match: null }] } });
    const row = host.querySelector('[data-editor-field="login.uris"]')!;
    expect(row.querySelector(':scope > [data-field-label]')).toBeNull();
    expect(row.querySelector('[data-editor-url="0"]')).not.toBeNull();
  });
  it.each([
    ['有效期月份', '11', '11', '2030'],
    ['有效期年份', '31', '02', '2031'],
  ] as const)('saves segmented %s edits to separate native expiry fields', async (label, entered, month, year) => {
    let saved: VaultItem | undefined;
    await mount({ ...blankEditorItem(), type: 'card', rawType: 3, name: 'Card', login: null,
      card: { ...blankCard(), expMonth: '02', expYear: '2030' } }, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelector<HTMLInputElement>('[aria-label="有效期年份"]')?.value).toBe('30');
    await input(host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!, entered);
    await click(button('保存'));
    expect(saved?.card?.expMonth).toBe(month);
    expect(saved?.card?.expYear).toBe(year);
  });
  it('saves a document date entered across three slots to its original native string field', async () => {
    let saved: VaultItem | undefined;
    await mount({ ...blankEditorItem(), type: 'passport', rawType: 8, name: 'Passport' }, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    for (const [label, value] of [['签发日期年份', '2026'], ['签发日期月份', '12'], ['签发日期日期', '31']]) {
      await input(host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!, value!);
    }
    await click(button('保存'));
    expect(saved?.passport?.issueDate).toBe('2026-12-31');
    expect(saved?.passport).not.toHaveProperty('issueYear');
  });
  it.each(['2027-01-02', '2027-02-31', ''])('saves a cleared legacy date replacement %j without losing focus or unrelated native values', async replacement => {
    let saved: VaultItem | undefined;
    await mount({ ...blankEditorItem(), type: 'passport', rawType: 8, name: 'Legacy passport',
      passport: { ...emptyPassport(), issueDate: '2026/10/09', expirationDate: '2030-12-31', passportNumber: 'kept-number' } },
    async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    const textbox = host.querySelector<HTMLInputElement>('[aria-label="签发日期"]')!;
    await act(() => textbox.focus());
    await input(textbox, '');
    expect(document.activeElement).toBe(textbox);
    if (replacement) await input(textbox, replacement);
    expect(host.querySelector('[aria-label="签发日期"]')).toBe(textbox);
    expect(document.activeElement).toBe(textbox);
    await click(button('保存'));
    expect(saved?.passport?.issueDate).toBe(replacement);
    expect(saved?.passport?.expirationDate).toBe('2030-12-31');
    expect(saved?.passport?.passportNumber).toBe('kept-number');
  });
  it('starts a new login with one website placeholder and omits it on save', async () => {
    let saved: VaultItem | undefined;
    await mount(null, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    expect(host.querySelectorAll('[aria-label="网址 1"]').length).toBe(1);
    expect(host.querySelector('[aria-label="验证码"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="备注"]')).not.toBeNull();
    await input(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!, 'New');
    await click(button('保存'));
    expect(saved?.login?.uris).toEqual([]);
  });
  it('clearing a fixed credential keeps its input and unrelated credentials intact', async () => {
    const item = { ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, username: 'alice', password: 'secret' } };
    let saved: VaultItem | undefined;
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    const password = host.querySelector<HTMLInputElement>('[aria-label="密码"]')!;
    await input(password, '');
    await input(host.querySelector<HTMLInputElement>('[aria-label="用户名"]')!, 'bob');
    expect(host.querySelector('[aria-label="密码"]')).toBe(password);
    expect(host.querySelector('[aria-label="移除密码"]')).toBeNull();
    await click(button('保存'));
    expect(saved?.login?.username).toBe('bob');
    expect(saved?.login?.password).toBe('');
  });
  it('keeps an empty URL input shell after the last URL is removed without saving a blank entry', async () => {
    let saved: VaultItem | undefined;
    const item = { ...blankEditorItem(), name: 'Login', login: { ...blankEditorItem().login!, uris: [{ uri: 'https://one.example', match: null }] } };
    await mount(item, async draft => { saved = draft; return { id: 'saved', name: draft.name }; });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="删除网址 1"]')!);
    expect(host.querySelector<HTMLInputElement>('[aria-label="网址 1"]')?.value).toBe('');
    expect(host.querySelectorAll('[data-editor-add-url]')).toHaveLength(1);
    await click(button('保存'));
    expect(saved?.login?.uris).toEqual([]);
  });
  it('does not dirty a saved empty login merely by showing all fields and its URL placeholder', async () => {
    const item = { ...blankEditorItem(), name: 'Empty login' };
    const before = structuredClone(item);
    let cancelled = 0;
    await mount(item, undefined, { onCancel: () => { cancelled++; } });
    expect(host.querySelector<HTMLInputElement>('[aria-label="网址 1"]')?.value).toBe('');
    await click(button('取消'));
    expect(cancelled).toBe(1);
    expect([...host.querySelectorAll('button')].some(node => node.textContent?.trim() === '放弃改动')).toBe(false);
    expect(item).toEqual(before);
  });
  it('returns focus to the custom-field trigger when a custom row is removed', async () => {
    await mount({ ...blankEditorItem(), name: 'Login', customFields: [{ name: 'Extra', value: 'value', type: 0, linkedId: null }] });
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="删除字段 1"]')!;
    remove.focus(); await click(remove);
    expect(document.activeElement).toBe(button('添加自定义字段'));
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
  it('creates the selected custom boolean while retaining the distinct URL add action', async () => {
    await mount({ ...blankEditorItem(), name: 'Login' });
    await click(button('添加自定义字段'));
    await click(host.querySelector<HTMLButtonElement>('[data-add-custom="2"]')!);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="字段 1 类型"]')?.value).toBe('2');
    expect(host.querySelector<HTMLInputElement>('[aria-label="字段 1 开关"]')?.checked).toBe(false);
    expect(host.querySelectorAll('[data-editor-add-url]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-editor-add-more]')).toHaveLength(1);
    expect([...host.querySelectorAll('button')].some(node => ['添加更多', '添加字段'].includes(node.textContent?.trim() ?? ''))).toBe(false);
  });
});
