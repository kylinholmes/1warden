// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NavDrawerProvider, summarise } from '@1warden/ui';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import type { ApplicationClient } from '../application/types';
import { TrashView } from './TrashView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const item = { ...summarise({ ...blankEditorItem(), id: 'trashed-fixture', name: 'Deleted fixture', deletedAt: '2026-01-01' }), restoreError: null };
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); });
async function mount(client: ApplicationClient) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(createElement(NavDrawerProvider, null, createElement(TrashView, { client, onBack() {} }))); });
}
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
it('reports loading errors instead of an empty trash and can reload and restore', async () => {
  const listTrash = vi.fn().mockRejectedValueOnce(new Error('Offline fixture')).mockResolvedValue([item]);
  let complete!: () => void;
  const restoreItem = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  await mount({ listTrash, restoreItem } as unknown as ApplicationClient);
  expect(host.textContent).toContain('Offline fixture');
  expect(host.textContent).not.toContain('回收站为空');
  await act(async () => { button('刷新').click(); });
  expect(host.textContent).toContain('Deleted fixture');
  await act(async () => { button('恢复').click(); });
  expect(button('恢复中…').disabled).toBe(true);
  expect(restoreItem).toHaveBeenCalledExactlyOnceWith(item.id);
  await act(async () => { complete(); });
  expect(host.textContent).toContain('已恢复「Deleted fixture」');
  expect(host.textContent).toContain('回收站为空');
});
it('keeps a record visible when restoring fails', async () => {
  await mount({ listTrash: async () => [item], restoreItem: async () => { throw new Error('Restore rejected'); } } as unknown as ApplicationClient);
  await act(async () => { button('恢复').click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Restore rejected');
  expect(host.querySelectorAll('ul.card > li')).toHaveLength(1);
  expect(button('恢复').disabled).toBe(false);
});

it('explains unreadable records without blocking restoration of healthy records', async () => {
  const broken = { ...item, id: 'broken-fixture', name: '', nameFailed: true,
    restoreError: '这条记录无法完整读取，请先用兼容客户端检查后再恢复' };
  const restoreItem = vi.fn().mockResolvedValue(undefined);
  await mount({ listTrash: async () => [broken, item], restoreItem } as unknown as ApplicationClient);
  const rows = [...host.querySelectorAll('ul.card > li')];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain('无法解密');
  expect(rows[0]!.textContent).toContain(broken.restoreError);
  const blocked = rows[0]!.querySelector('button')!;
  expect(blocked.disabled).toBe(true);
  await act(() => blocked.click());
  expect(restoreItem).not.toHaveBeenCalled();
  const healthy = rows[1]!.querySelector('button')!;
  expect(healthy.disabled).toBe(false);
  await act(async () => healthy.click());
  expect(restoreItem).toHaveBeenCalledExactlyOnceWith(item.id);
  expect(host.textContent).toContain('已恢复「Deleted fixture」');
  expect(host.querySelectorAll('ul.card > li')).toHaveLength(1);
  expect(host.textContent).toContain(broken.restoreError);
});
