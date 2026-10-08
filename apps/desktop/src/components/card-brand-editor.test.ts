// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ItemEditor } from '../../../../packages/ui/src/ItemEditor';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { emptyCard, type VaultItem } from '@1warden/vault';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['Mastercard', 'visa', 'Local card network'].flatMap(brand => [
  { brand, target: brand }, { brand, target: 'UnionPay' },
]))('selects $target while preserving other data from $brand', async ({ brand, target }) => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const item: VaultItem = { ...blankEditorItem(), name: 'Test card', type: 'card', rawType: 3, login: null,
    card: { ...emptyCard(), brand, number: 'synthetic-number' } };
  let saved: VaultItem | undefined;
  try {
    await act(() => root.render(createElement(ItemEditor, { item, open: true, folders: [], onDone() {}, onCancel() {},
      onSave: async draft => { saved = draft; return { id: 'saved', name: draft.name }; } })));
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="卡片品牌"]');
    expect(picker).not.toBeNull();
    expect(host.querySelector('input[aria-label="卡片品牌"]')).toBeNull();
    expect(picker!.value).toBe(brand);
    expect([...picker!.options].some(option => option.value === 'UnionPay')).toBe(true);
    const save = [...host.querySelectorAll('button')].find(button => button.textContent === '保存')!;
    if (target !== brand) await act(() => { picker!.value = target; picker!.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => save.click());
    expect(saved?.card?.brand).toBe(target);
    expect(saved?.card?.number).toBe('synthetic-number');
  } finally { await act(() => root.unmount()); host.remove(); }
});
