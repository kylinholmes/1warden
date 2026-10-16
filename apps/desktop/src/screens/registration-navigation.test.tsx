// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installHost, resetHost } from '@1warden/ui';
import { Register } from './Register';
import type { ApplicationClient } from '../application/types';
const mocks = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), keys: vi.fn() }));
vi.mock('@1warden/api', async original => ({ ...await original<typeof import('@1warden/api')>(), beginRegistration: mocks.begin, finishRegistration: mocks.finish }));
vi.mock('./registration-keys', async original => ({ ...await original<typeof import('./registration-keys')>(), createRegistrationKeys: mocks.keys }));
let root: Root; let host: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  mocks.begin.mockReset(); mocks.finish.mockReset(); mocks.keys.mockReset();
  installHost({ fetch: async () => Response.json({ version: 'fixture' }), storage: { get: async () => null, set: async () => {}, remove: async () => {} } });
});
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); resetHost(); });
async function mount() {
  const onHome = vi.fn(async () => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const client = { capabilities: { native: false }, connectionDraft: { save: async () => {} } } as unknown as ApplicationClient;
  await act(async () => { root.render(createElement(Register, { client, initialDraft: { serverUrl: 'https://vault.example.test', email: 'test@example.test', error: null }, onHome, onLogin: async () => {} })); });
  return onHome;
}
async function submit() { await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function back() { await act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回首页"]')!.click()); }
async function passwords() {
  await act(() => { for (const input of host.querySelectorAll<HTMLInputElement>('input[type=password]')) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'synthetic-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } });
}
it('returns while a registration request is pending and ignores its late result', async () => {
  let finish!: (value: unknown) => void;
  mocks.begin.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onHome = await mount(); await submit(); await back();
  expect(onHome).toHaveBeenCalledOnce();
  await act(() => finish({ kind: 'setPassword', token: 'fixture' }));
  expect(host.querySelector('input[type=password]')).toBeNull(); expect(mocks.finish).not.toHaveBeenCalled();
});
it('does not send registration after leaving during key derivation', async () => {
  let finish!: (value: unknown) => void;
  mocks.begin.mockResolvedValue({ kind: 'setPassword', token: 'fixture' });
  mocks.keys.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onHome = await mount(); await submit(); await passwords(); await submit(); await back();
  expect(onHome).toHaveBeenCalledOnce(); await act(() => finish({ key: 'encrypted-fixture' }));
  expect(mocks.finish).not.toHaveBeenCalled();
});
it('leaving after submission never lets late completion revive the registration screen', async () => {
  let finish!: () => void;
  mocks.begin.mockResolvedValue({ kind: 'setPassword', token: 'fixture' }); mocks.keys.mockResolvedValue({ key: 'encrypted-fixture' });
  mocks.finish.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const onHome = await mount(); await submit(); await passwords(); await submit();
  expect(host.textContent).toContain('已提交的注册仍可能完成'); await back();
  expect(onHome).toHaveBeenCalledOnce(); await act(() => finish());
  expect(host.textContent).not.toContain('账户已创建');
});
