// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHost, resetHost } from '@1warden/ui';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ConnectionDraft } from './application/types';
import { App } from './App';

vi.mock('./components/AccountMetadata', () => ({ AccountMetadataProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./components/Toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./components/ProfileAutosave', () => ({ ProfileAutosaveProvider: ({ children }: { children: ReactNode }) => children, useProfileAutosave: () => undefined }));
vi.mock('./screens/VaultView', () => ({ VaultView: () => createElement('p', null, 'Vault fixture') }));
vi.mock('./screens/registration-keys', () => ({
  validateRegistrationPassword: (password: string, confirmation: string) => {
    if (password !== confirmation) throw new Error('两次输入的主密码不一致');
  },
  createRegistrationKeys: vi.fn(async () => ({ masterPasswordHash: 'hash', key: 'encrypted-key',
    keys: { publicKey: 'public-key', encryptedPrivateKey: 'encrypted-private-key' },
    kdfType: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null })),
}));

let root: Root;
let node: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
let saved: string | null;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  request = vi.fn();
  saved = null;
  installHost({ fetch: request as typeof fetch, storage: { get: async key => key === '1warden.accounts' ? saved : null, set: async () => {}, remove: async () => {} } });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(() => root.unmount()); node.remove(); resetHost(); });
function client(initial: ConnectionDraft | null = null) {
  let draft = initial;
  const save = vi.fn(async (value: ConnectionDraft) => { draft = structuredClone(value); });
  const value = { initialize: async () => {}, getSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: () => () => {}, switchAccount: vi.fn(async () => {}),
    connect: vi.fn(async () => {}), capabilities: { native: false, browser: false, saveAttachments: false },
    connectionDraft: { load: async () => draft, save, clear: async () => { draft = null; } },
  } as unknown as ApplicationClient;
  return { value, save, draft: () => draft };
}
async function mount(value: ApplicationClient) { await act(() => root.render(createElement(App, { client: value }))); }
async function click(text: string) {
  const button = [...node.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button ${text} in ${node.textContent}`);
  await act(() => button.click());
}
async function input(label: string, value: string) {
  const field = [...node.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))?.querySelector('input');
  if (!field) throw new Error(`Missing field ${label}`);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function value(label: string) {
  return [...node.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))?.querySelector('input')?.value;
}
async function submit() { await act(() => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function chooseServer(choice: string) {
  await act(() => (node.querySelector('[role="combobox"][aria-label="服务器"]') as HTMLButtonElement).click());
  const option = [...node.querySelectorAll('[role="option"]')].find(item => item.getAttribute('data-value') === choice);
  if (!option) throw new Error(`Missing server option ${choice}`);
  await act(() => (option as HTMLElement).click());
}

describe('login and registration entry', () => {
  it('defaults to the community service, only shows an address for custom, and preserves custom text when switching', async () => {
    const test = client(); await mount(test.value); await click('登录');
    expect(node.querySelector('[role="combobox"]')?.textContent).toContain('Vaultwarden.com（社区托管）');
    expect(node.querySelector('input[type="url"]')).toBeNull();
    await chooseServer('custom'); await input('服务器地址', 'https://vault.example.com/team');
    await input('主密码', 'clear-on-server-change');
    await chooseServer('bitwarden-eu');
    expect(value('主密码')).toBe('');
    expect(node.querySelector('input[type="url"]')).toBeNull();
    expect(test.draft()?.serverUrl).toBe('https://vault.bitwarden.eu');
    await chooseServer('custom'); expect(value('服务器地址')).toBe('https://vault.example.com/team');
    expect(request).not.toHaveBeenCalled(); expect(test.value.connect).not.toHaveBeenCalled();
  });
  it('uses the community preset for a new registration and sends nothing until Continue', async () => {
    const test = client(); await mount(test.value); await click('注册');
    expect(node.querySelector('[role="combobox"]')?.textContent).toContain('Vaultwarden.com（社区托管）');
    expect(node.querySelector('input[type="url"]')).toBeNull();
    expect(test.draft()?.serverUrl).toBe('https://vault.vaultwarden.com');
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await input('邮箱', 'person@example.test'); await submit();
    expect(String(request.mock.calls[0]![0])).toBe('https://vault.vaultwarden.com/identity/accounts/register/send-verification-email');
  });
  it('offers saved servers once each and reuses the last server without changing account identity', async () => {
    saved = JSON.stringify([{ serverUrl: 'https://vault.example.com/team', email: 'a@example.test' },
      { serverUrl: 'https://vault.example.com/team', email: 'b@example.test' }]);
    const test = client(); await mount(test.value); await click('登录其他账户');
    expect(node.querySelector('[role="combobox"]')?.textContent).toContain('已保存：vault.example.com/team');
    expect(node.querySelector('input[type="url"]')).toBeNull();
    await act(() => (node.querySelector('[role="combobox"]') as HTMLButtonElement).click());
    expect([...node.querySelectorAll('[role="option"]')].filter(item => item.textContent?.startsWith('已保存：'))).toHaveLength(1);
    expect(test.draft()?.serverUrl).toBe('https://vault.example.com/team');
    expect(value('邮箱')).toBe('');
  });
  it.each([undefined, 'register'] as const)('preserves an explicitly empty custom server draft (%s) across entry navigation', async intent => {
    const test = client({ serverUrl: '', email: 'person@example.test', error: null, ...(intent ? { intent } : {}) });
    await mount(test.value);
    expect(value('服务器地址')).toBe('');
    expect(node.querySelector('[role="combobox"]')?.textContent).toContain('自定义服务器');
    if (!intent) await click('创建账户');
    expect(value('服务器地址')).toBe('');
    await click('已有账户？登录');
    expect(value('服务器地址')).toBe(''); expect(test.draft()?.serverUrl).toBe('');
    expect(value('邮箱')).toBe('person@example.test'); expect(request).not.toHaveBeenCalled();
  });
  it.each(['https://vault.bitwarden.com', 'https://vault.bitwarden.eu', 'https://vault.bitwarden.com:443', 'https://VAULT.BITWARDEN.EU/'])('opens %s registration in the correct official web vault without calling registration APIs', async serverUrl => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const test = client({ serverUrl, email: 'person@example.test', error: null, intent: 'register' });
      await mount(test.value);
      expect(node.querySelector('input[type="url"]')).toBeNull(); expect(node.querySelector('input[type="password"]')).toBeNull();
      await click('前往 Bitwarden 注册');
      expect(opened).toHaveBeenCalledWith(`${new URL(serverUrl).origin}/#/register`, '_blank', 'noopener,noreferrer');
      await submit();
      expect(request).not.toHaveBeenCalled(); expect(test.value.connect).not.toHaveBeenCalled();
      await click('已有账户？登录');
      expect(value('邮箱')).toBe('person@example.test'); expect(test.draft()?.serverUrl).toBe(serverUrl);
    } finally { opened.mockRestore(); }
  });
  it.each(['login draft', 'registration intent'])('Back cancels a pending %s write without reopening registration or restoring the abandoned draft', async pendingKind => {
    const test = client(); await mount(test.value); await click('登录');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const persist = test.save.getMockImplementation()!;
    let held = false;
    test.save.mockImplementation(async draft => {
      if (!held && (pendingKind === 'login draft' ? !draft.intent : draft.intent === 'register')) {
        held = true; await pending;
      }
      await persist(draft);
    });
    if (pendingKind === 'login draft') await input('邮箱', 'person@example.test');
    await click('创建账户');
    expect(held).toBe(true);
    await click('返回上一级');
    expect(node.querySelector('h1')?.textContent).toBe('你的密码，从这里开始');
    await act(async () => { release(); await pending; });
    expect(node.querySelector('h1')?.textContent).toBe('你的密码，从这里开始');
    expect(test.draft()).toBeNull();
  });
  it('starts with login and registration choices, then preserves public fields across both flows', async () => {
    const test = client(); await mount(test.value);
    expect(node.querySelector('input')).toBeNull();
    expect(node.textContent).not.toContain('添加服务器');
    await click('登录');
    await chooseServer('custom');
    await input('邮箱', 'person@example.test'); await input('服务器地址', 'https://vault.test/team');
    await input('主密码', 'do-not-keep-this-password');
    await click('创建账户');
    expect(node.textContent).toContain('创建账户');
    expect(value('邮箱')).toBe('person@example.test'); expect(value('服务器地址')).toBe('https://vault.test/team');
    expect(node.querySelector('input[type="password"]')).toBeNull();
    await click('已有账户？登录');
    expect(value('邮箱')).toBe('person@example.test'); expect(value('服务器地址')).toBe('https://vault.test/team');
    expect(value('主密码')).toBe('');
    expect(JSON.stringify(test.draft())).not.toContain('do-not-keep');
    expect(test.draft()?.intent).toBeUndefined();
  });
  it('restores registration intent, handles required email verification, and returns to prefilled login', async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const test = client({ serverUrl: 'https://vault.test', email: 'person@example.test', error: null, intent: 'register' });
    await mount(test.value); await submit();
    expect(node.textContent).toContain('检查你的邮箱');
    expect(node.querySelector('input[type="password"]')).toBeNull();
    expect(test.value.connect).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
    await click('已完成注册，去登录');
    expect(value('邮箱')).toBe('person@example.test'); expect(value('主密码')).toBe('');
  });
  it('only reports success after /finish, never stores token/password, and never logs in automatically', async () => {
    request.mockResolvedValueOnce(Response.json('header.payload.signature')).mockResolvedValueOnce(Response.json({ object: 'registerFinish' }));
    const test = client({ serverUrl: 'https://vault.test', email: 'person@example.test', error: null, intent: 'register' });
    await mount(test.value); await submit();
    await input('主密码', 'a long test password'); await input('确认主密码', 'different password'); await submit();
    expect(node.textContent).toContain('两次输入的主密码不一致'); expect(request).toHaveBeenCalledOnce();
    await input('确认主密码', 'a long test password'); await submit();
    expect(node.textContent).toContain('账户已创建'); expect(request).toHaveBeenCalledTimes(2);
    expect(test.value.connect).not.toHaveBeenCalled(); expect(node.querySelector('input[type="password"]')).toBeNull();
    expect(JSON.stringify(test.save.mock.calls)).not.toMatch(/header.payload.signature|a long test password/);
    await click('登录新账户'); expect(value('邮箱')).toBe('person@example.test'); expect(value('主密码')).toBe('');
  });
  it('keeps registration rejection visible and leaves the login choice available', async () => {
    request.mockResolvedValueOnce(Response.json({ message: 'Registration not allowed or user already exists' }, { status: 400 }));
    const test = client({ serverUrl: 'https://vault.test', email: 'person@example.test', error: null, intent: 'register' });
    await mount(test.value); await submit();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('未开放注册或该邮箱已注册');
    expect(node.textContent).not.toContain('邮箱或主密码不正确');
    await click('已有账户？登录'); expect(value('邮箱')).toBe('person@example.test');
  });
});
