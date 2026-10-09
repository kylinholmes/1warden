// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyLogin } from '@1warden/vault';
import { ItemDetail } from '../screens/VaultView';
import { itemDetail } from '../application/service';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
async function checkDetail(check: (host: HTMLElement) => void) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const detail = itemDetail({ ...blankEditorItem(), id: 'synthetic-credentials', name: 'Synthetic credentials',
    login: { ...emptyLogin(), username: 'Synthetic user', password: 'Synthetic password', totp: 'Synthetic seed' } });
  detail.login!.passkeys = [{ credentialId: 'synthetic-credential', rpId: 'example.invalid', rpName: 'Synthetic passkey',
    userName: 'user', userDisplayName: 'User', creationDate: '2026-10-09' }];
  const client = {
    capabilities: { native: false, browser: true, saveAttachments: true },
    getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {},
    totp: vi.fn(async () => ({ code: '123456', remaining: 20, period: 30 })),
  } satisfies Pick<ApplicationClient, 'capabilities' | 'getSnapshot' | 'subscribe' | 'totp'>;
  try {
    await act(async () => root.render(<ItemDetail client={client as unknown as ApplicationClient} item={detail} icons={null}
      onBack={() => {}} onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />));
    check(host);
  } finally { await act(() => root.unmount()); host.remove(); }
}

describe('compact credential rows keep actions and countdown discoverable', () => {
  it('uses compact OTP spacing but keeps the complete timer persistent beside copy', async () => {
    await checkDetail(host => {
      const row = host.querySelector<HTMLElement>('[data-field-layout="totp"]')!;
      expect(row.classList.contains('py-2')).toBe(true);
      expect(row.classList.contains('items-center')).toBe(true);
      const actions = row.querySelector<HTMLElement>(':scope > [data-field-actions]')!;
      const timer = actions.querySelector<HTMLElement>('[role="timer"]')!;
      expect(timer.hasAttribute('data-field-persistent')).toBe(true);
      expect(timer.getAttribute('aria-label')).toBe('验证码剩余 20 秒');
      expect(timer.classList.contains('h-[30px]')).toBe(true);
      expect(timer.classList.contains('w-[30px]')).toBe(true);
      expect(timer.textContent?.trim()).toBe('20');
      expect(actions.classList.contains('items-center')).toBe(true);
      expect(actions.classList.contains('hidden')).toBe(false);
      expect(actions.querySelector('button')).not.toBeNull();
      expect(actions.querySelector('button')?.hasAttribute('data-field-persistent')).toBe(false);
      expect(row.querySelector('[data-field-content]')?.classList.contains('gap-1')).toBe(true);
    });
  });
  it('keeps passkey add/delete persistent and centers actions on compact rows', async () => {
    await checkDetail(host => {
      const fieldset = host.querySelector<HTMLElement>('[data-login-passkeys]')!;
      expect(fieldset.classList.contains('py-2')).toBe(true);
      expect(fieldset.classList.contains('py-2.5')).toBe(false);
      const row = fieldset.querySelector<HTMLElement>('[data-field-layout="passkeys"]')!;
      expect(row.classList.contains('items-center')).toBe(true);
      expect(row.querySelector('[data-field-content]')?.classList.contains('gap-1')).toBe(true);
      const add = fieldset.querySelector<HTMLButtonElement>('[aria-label="前往网站添加通行密钥"]')!;
      const remove = fieldset.querySelector<HTMLButtonElement>('[aria-label="删除通行密钥 Synthetic passkey"]')!;
      expect(add.hasAttribute('data-field-persistent')).toBe(true);
      expect(remove.hasAttribute('data-field-persistent')).toBe(true);
      expect(remove.parentElement!.classList.contains('items-center')).toBe(true);
      expect(remove.parentElement!.classList.contains('py-2')).toBe(true);
      expect(remove.parentElement!.classList.contains('py-3')).toBe(false);
    });
  });
});
