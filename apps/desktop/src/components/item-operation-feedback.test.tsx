// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { summarise } from '@1warden/ui';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot, type ItemDetailData } from '../application/types';
import { ItemDetail } from '../screens/VaultView';
import { ToastProvider, useToast } from './Toast';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; host?.remove(); });

const item: ItemDetailData = {
  summary: summarise({ ...blankEditorItem(), id: 'feedback-item', name: 'Fixture' }), rawType: 1,
  notes: null, notesFailed: false, login: null, card: null, identity: null, sshKey: null,
  customFields: [], passwordHistory: [{ lastUsedDate: '2026-01-01T00:00:00Z' }],
  attachments: [{ id: 'fixture-attachment', fileName: 'fixture.txt', size: '1', sizeName: '1 B', failed: false }],
};
const account = { serverUrl: 'https://fixture.invalid', email: 'fixture@example.invalid', userId: 'fixture-user',
  kdf: { kdf: 0 as const, iterations: 600000 } };
const folder = { id: 'fixture-folder', name: 'Fixture folder', nameFailed: false, updatedAt: '2026-01-01T00:00:00Z' };
function fixture() {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', account, items: [item.summary],
    folders: [folder] };
  const listeners = new Set<() => void>();
  let fail!: (reason: Error) => void;
  const operation = vi.fn(() => new Promise<never>((_, reject) => { fail = reject; }));
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    capabilities: { native: false, browser: false, saveAttachments: true },
    downloadAttachment: operation, moveToFolder: operation, reveal: operation,
    createFolder: vi.fn(async () => folder),
  } as unknown as ApplicationClient;
  return { client, operation, fail: (message = 'Synthetic operation failure') => fail(new Error(message)),
    publish: (patch: Partial<ApplicationSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); } };
}
function View({ client, visible = true, revision = 0, notify = true, observe }: { client: ApplicationClient; visible?: boolean; revision?: number; notify?: boolean; observe?: (message: string) => void }) {
  const toast = useToast();
  return visible ? createElement(ItemDetail, { key: revision, client, item, folders: client.getSnapshot().folders, icons: null,
    onBack: () => {}, onEdit: () => {}, onDelete: () => {}, onToggleFavorite: () => {},
    ...(notify ? { onError: (message: string) => { observe?.(message); toast.show({ tone: 'danger', message }); } } : {}) }) : null;
}
async function render(client: ApplicationClient, options: { visible?: boolean; revision?: number; notify?: boolean; observe?: (message: string) => void } = {}) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(() => root!.render(createElement(ToastProvider, null, createElement(View, { client, ...options }))));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
  expect(button).toBeDefined();
  await act(() => button.click());
}
async function start(kind: 'resource' | 'folder' | 'history') {
  if (kind === 'resource') await click('取回');
  else if (kind === 'history') {
    const toggle = host.querySelector<HTMLButtonElement>('[data-password-history] > button')!;
    if (toggle.getAttribute('aria-expanded') !== 'true') await act(() => toggle.click());
    await act(() => host.querySelector<HTMLButtonElement>('[data-password-history] [aria-label="显示"]')!.click());
  }
  else {
    await click('更改');
    const select = host.querySelector<HTMLSelectElement>('[data-item-folder]')!;
    await act(() => { select.value = 'fixture-folder'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  }
}

it.each(['resource', 'folder', 'history'] as const)('shows a %s failure exactly once through the notification owner', async kind => {
  const f = fixture(); const observe = vi.fn(); await render(f.client, { observe }); await start(kind);
  await act(() => f.fail());
  expect(f.operation).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledExactlyOnceWith('Synthetic operation failure');
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('[aria-label="通知"] [role="alert"]')?.textContent).toContain('Synthetic operation failure');
  expect(host.querySelector('article [role="alert"]')).toBeNull();
});
it.each(['resource', 'folder', 'history'] as const)('keeps one inline fallback for standalone %s views without notifications', async kind => {
  const f = fixture(); await render(f.client, { notify: false }); await start(kind);
  await act(() => f.fail());
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('article [role="alert"]')?.textContent).toBe('Synthetic operation failure');
});
it.each(['resource', 'folder', 'history'] as const)('reports a pending %s failure after the detail remounts', async kind => {
  const f = fixture(); await render(f.client); await start(kind);
  await render(f.client, { revision: 1 });
  await act(() => f.fail());
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic operation failure');
});
it.each(['resource', 'folder', 'history'] as const)('reports a pending %s failure after leaving the item', async kind => {
  const f = fixture(); await render(f.client); await start(kind);
  await render(f.client, { visible: false });
  await act(() => f.fail());
  expect(host.querySelector('article')).toBeNull();
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
});
it.each(['resource', 'folder', 'history'] as const)('suppresses old-account %s failures even after switching back', async kind => {
  const f = fixture(); await render(f.client); await start(kind);
  await render(f.client, { visible: false });
  await act(() => {
    f.publish({ account: { ...account, email: 'other@example.invalid', userId: 'other-user' } });
    f.publish({ account });
    f.fail('Private old-account failure');
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it.each(['resource', 'folder', 'history'] as const)('suppresses pending %s failures across lock and unlock', async kind => {
  const f = fixture(); await render(f.client); await start(kind);
  await render(f.client, { visible: false });
  await act(() => {
    f.publish({ status: 'locked' });
    f.publish({ status: 'unlocked' });
    f.fail('Private locked-session failure');
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it.each(['resource', 'folder'] as const)('reenables %s controls and supports retry after failure', async kind => {
  const f = fixture(); await render(f.client); await start(kind);
  await act(() => f.fail());
  if (kind === 'resource') await click('取回');
  else {
    const select = host.querySelector<HTMLSelectElement>('[data-item-folder]')!;
    expect(select.disabled).toBe(false);
    await act(() => { select.value = 'fixture-folder'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  expect(f.operation).toHaveBeenCalledTimes(2);
  await act(() => f.fail());
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic operation failure');
});
it('keeps a created-folder assignment failure visible after creation remounts detail', async () => {
  const f = fixture(); await render(f.client); await click('更改'); await click('新建文件夹');
  const input = host.querySelector<HTMLInputElement>('[data-item-folder-name]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fixture folder');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('创建并归类');
  await render(f.client, { revision: 1 });
  expect(host.querySelector('[data-folder-organization]')?.getAttribute('aria-busy')).toBe('true');
  await act(() => f.fail());
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('文件夹已创建，条目归类未完成');
});
