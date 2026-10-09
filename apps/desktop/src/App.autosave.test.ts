// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountTarget } from './application/account-target';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from './application/types';
import { App } from './App';

vi.mock('./components/AccountMetadata', () => ({ AccountMetadataProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./components/Toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./screens/Connect', () => ({ Connect: () => createElement('p', null, 'Connect fixture') }));
vi.mock('./screens/Unlock', () => ({ Unlock: ({ onDisconnect }: { onDisconnect: () => void }) =>
  createElement('button', { onClick: onDisconnect }, '返回首页 fixture') }));
vi.mock('./screens/Home', () => ({ Home: ({ onPick }: {
  onPick: (account: AccountTarget) => void;
}) => createElement('button', { onClick: () => onPick({ serverUrl: 'https://a.test', email: 'a@test.com' }) }, '打开账户 fixture') }));
vi.mock('./screens/VaultView', async () => {
  const { ProfileEditor } = await import('./components/ProfileEditor');
  return { VaultView: ({ client, onLogout, onSwitchAccount }: {
    client: ApplicationClient; onLogout: () => Promise<void>; onSwitchAccount: (account: AccountTarget) => Promise<void>;
  }) => createElement('main', null,
    createElement(ProfileEditor, { client }),
    createElement('button', { onClick: () => { void onLogout().catch(() => {}); } }, '退出 fixture'),
    createElement('button', { onClick: () => { void onSwitchAccount({ serverUrl: 'https://b.test', email: 'b@test.com' }).catch(() => {}); } }, '切换 fixture')) };
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
});
function setup() {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', profileReady: true,
    account: { serverUrl: 'https://a.test', email: 'a@test.com', userId: 'test', kdf: { kdf: 0, iterations: 1 } },
    profile: { displayName: 'Before', avatarDataUrl: null }, profileVersion: '1' };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ApplicationSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  const saveProfile = vi.fn(async profile => { update({ profile, profileVersion: '2' }); });
  const logout = vi.fn(async () => { update({ ...EMPTY_SNAPSHOT }); });
  const switchAccount = vi.fn(async (account: AccountTarget | null) => {
    update(account ? { status: 'locked', account: { userId: 'test', kdf: { kdf: 0, iterations: 1 }, ...account } }
      : { ...EMPTY_SNAPSHOT });
  });
  const client = { initialize: async () => {}, getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, saveProfile,
    savePreferences: vi.fn(async () => {}), logout, switchAccount } as unknown as ApplicationClient;
  return { client, update, saveProfile, logout, switchAccount };
}
async function click(text: string) {
  const control = [...host!.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
  if (!control) throw new Error(`Missing button: ${text}`);
  await act(() => control.click());
}
async function input(value: string) {
  const control = host!.querySelector<HTMLInputElement>('#profile-name')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(client: ApplicationClient) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(createElement(App, { client })));
  await click('打开账户 fixture');
}

describe('App preserves unsaved profile changes at authentication boundaries', () => {
  it.each(['退出 fixture', '切换 fixture'])('blocks %s on save failure, retains the mounted draft, then allows retry', async action => {
    const test = setup(); test.saveProfile.mockRejectedValueOnce(new Error('offline'));
    await mount(test.client); await input('My retained draft');
    const field = host!.querySelector<HTMLInputElement>('#profile-name')!;
    await click(action);
    expect(test.logout).not.toHaveBeenCalled();
    expect(test.switchAccount).not.toHaveBeenCalled();
    expect(host!.querySelector('#profile-name')).toBe(field);
    expect(field.value).toBe('My retained draft');
    expect(host!.textContent).toContain('尚未保存');
    await click(action);
    expect(test.saveProfile).toHaveBeenCalledTimes(1);
    await click('重试保存');
    expect(test.saveProfile).toHaveBeenCalledTimes(2);
    await click(action);
    expect(action === '退出 fixture' ? test.logout : test.switchAccount).toHaveBeenCalledTimes(1);
  });
  it('can return to the same locked account from Home with its parked draft intact', async () => {
    const test = setup(); await mount(test.client); await input('Unlock later');
    await act(() => test.update({ status: 'locked' }));
    // Returning Home must not require the parked, locked draft to be saved.
    await click('返回首页 fixture');
    await click('打开账户 fixture');
    expect(host!.textContent).toContain('返回首页 fixture');
    await act(() => test.update({ status: 'unlocked', profileReady: true,
      profile: { displayName: 'Before', avatarDataUrl: null }, profileVersion: '1' }));
    expect(host!.querySelector<HTMLInputElement>('#profile-name')?.value).toBe('Unlock later');
  });
  it('disables profile editing and reports incompatible settings instead of silently rejecting edits', async () => {
    const test = setup(); test.update({ profileSettingsError: '此设置版本暂不支持' });
    await mount(test.client);
    expect(host!.querySelector<HTMLInputElement>('#profile-name')?.disabled).toBe(true);
    expect(host!.querySelector<HTMLInputElement>('[type="file"]')?.disabled).toBe(true);
    expect([...host!.querySelectorAll('button')].find(node => node.textContent === '选择头像')?.disabled).toBe(true);
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe('此设置版本暂不支持');
    expect(test.saveProfile).not.toHaveBeenCalled();
  });
});
