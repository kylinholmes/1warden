// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyLogin } from '@1warden/vault';
import { ItemDetail } from '../screens/VaultView';
import { itemDetail } from '../application/service';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ItemDetailData } from '../application/types';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const saved = { credentialId: 'synthetic-passkey', rpId: 'example.invalid', rpName: 'Synthetic website',
  userName: 'synthetic-user', userDisplayName: 'Synthetic person', creationDate: '2026-01-01' };
async function mount(passkeys: NonNullable<ItemDetailData['login']>['passkeys']) {
  const detail = itemDetail({ ...blankEditorItem(), id: 'synthetic-login', name: 'Synthetic login',
    login: { ...emptyLogin(), username: 'Synthetic username', password: 'Synthetic password' } });
  if (passkeys === undefined) delete detail.login!.passkeys;
  else detail.login!.passkeys = passkeys;
  const snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked' as const,
    account: { email: 'fixture@example.invalid', serverUrl: 'https://example.invalid', userId: 'fixture', kdf: { kdf: 0 as const, iterations: 1 } } };
  const removePasskey = vi.fn(async () => {});
  const client = { capabilities: { native: false, browser: false, saveAttachments: false },
    getSnapshot: () => snapshot, subscribe: () => () => {}, removePasskey } as unknown as ApplicationClient;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(() => root.render(<ItemDetail client={client} item={detail} icons={null}
    onBack={() => {}} onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />));
  cleanups.push(async () => { await act(() => root.unmount()); host.remove(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!;
  return { host, removePasskey, button };
}
it.each([{ label: 'missing', passkeys: undefined }, { label: 'empty', passkeys: [] }])('omits an empty passkey row entirely ($label)', async ({ passkeys }) => {
  const { host } = await mount(passkeys);
  expect(host.querySelector('[data-login-passkeys]')).toBeNull();
  expect(host.textContent).not.toContain('未保存');
  expect(host.querySelector('[aria-label="前往网站添加通行密钥"]')).toBeNull();
  expect(host.textContent).toContain('Synthetic username');
});
it('shows the saved passkey count and identifying metadata', async () => {
  const { host } = await mount([saved, { ...saved, credentialId: 'synthetic-second', rpName: 'Second website' }]);
  const row = host.querySelector('[data-login-passkeys]')!;
  expect(row.textContent).toContain('已保存 2 个');
  for (const value of ['Synthetic website', 'Second website', 'example.invalid', 'Synthetic person', 'synthetic-user', '创建']) expect(row.textContent).toContain(value);
  expect(row.textContent).not.toContain('未保存');
});
it('hides the row after confirmed removal of the last saved passkey', async () => {
  const { host, button, removePasskey } = await mount([saved]);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="删除通行密钥 Synthetic website"]')!.click());
  expect(removePasskey).not.toHaveBeenCalled();
  await act(async () => button('确认删除').click());
  expect(removePasskey).toHaveBeenCalledExactlyOnceWith('synthetic-login', 'synthetic-passkey');
  expect(host.querySelector('[data-login-passkeys]')).toBeNull();
  expect(host.textContent).toContain('Synthetic username');
});
it('retains the saved passkey and reports failure when removal fails', async () => {
  const { host, button, removePasskey } = await mount([saved]);
  removePasskey.mockRejectedValueOnce(new Error('Synthetic removal failure'));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="删除通行密钥 Synthetic website"]')!.click());
  await act(async () => button('确认删除').click());
  expect(host.querySelector('[data-login-passkeys]')?.textContent).toContain('已保存 1 个');
  expect(host.textContent).toContain('Synthetic removal failure');
});
