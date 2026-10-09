// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { summarise } from '@1warden/ui';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ItemDetailData } from '../application/types';
import { ItemFolderPicker } from './ItemMetadata';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it('handles Escape inside folder creation without sending it to the vault detail shortcut', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const item: ItemDetailData = {
    summary: summarise({ ...blankEditorItem(), id: 'selected-item' }), rawType: 1,
    notes: null, notesFailed: false, login: null, card: null, identity: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
  const client = { getSnapshot: () => EMPTY_SNAPSHOT } as ApplicationClient;
  let detailClosed = false;
  const vaultShortcut = (event: KeyboardEvent) => { if (event.key === 'Escape') detailClosed = true; };
  window.addEventListener('keydown', vaultShortcut);
  try {
    await act(() => root.render(createElement(ItemFolderPicker, { client, item, folders: [] })));
    expect(host.querySelector('[data-item-folder]')).toBeNull();
    expect([...host.querySelectorAll('button')].some(button => button.textContent === '新建文件夹')).toBe(false);
    const manage = host.querySelector<HTMLButtonElement>('[aria-label="更改文件夹归类"]')!;
    await act(() => manage.click());
    expect([...host.querySelectorAll('option')].some(option => option.textContent?.includes('新建文件夹'))).toBe(false);
    expect([...host.querySelectorAll('button')].filter(button => button.textContent === '新建文件夹')).toHaveLength(1);
    const create = [...host.querySelectorAll('button')].find(button => button.textContent === '新建文件夹')!;
    await act(() => create.click());
    const input = host.querySelector<HTMLInputElement>('[data-item-folder-name]')!;
    expect(input).not.toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(() => input.dispatchEvent(escape));
    expect(host.querySelector('[data-item-folder-name]')).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(detailClosed).toBe(false);
    const select = host.querySelector<HTMLSelectElement>('[data-item-folder]')!;
    const closeEditor = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(() => select.dispatchEvent(closeEditor));
    expect(host.querySelector('[data-item-folder]')).toBeNull();
    expect(document.activeElement).toBe(manage);
    expect(detailClosed).toBe(false);
  } finally {
    window.removeEventListener('keydown', vaultShortcut);
    await act(() => root.unmount()); host.remove();
  }
});
