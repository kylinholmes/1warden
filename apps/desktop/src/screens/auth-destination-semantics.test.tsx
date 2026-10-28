// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectScreen, type SavedAccount } from '@1warden/ui';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';
import { Connect } from './Connect';
import { Unlock } from './Unlock';

const fixture = vi.hoisted(() => ({ accounts: [] as SavedAccount[] | null }));
vi.mock('@1warden/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@1warden/ui')>(),
  useAccounts: () => fixture.accounts,
  ServerSpeed: () => null,
}));
vi.mock('../../../../packages/ui/src/server-latency', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../packages/ui/src/server-latency')>(),
  useServerLatencies: () => ({ get: () => ({ status: 'idle' }) }),
}));
vi.mock('../trust', () => ({ probeCertificate: vi.fn(async () => ({
  fingerprint: 'SYNTHETIC', subject: 'fixture.invalid', issuer: 'Synthetic fixture',
  notBefore: '', notAfter: '', isSelfSigned: true, alreadyTrusted: false,
})) }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.accounts = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const account = { serverUrl: 'https://fixture.invalid', email: 'synthetic@fixture.invalid' };
function client(overrides: Partial<ApplicationClient> = {}): ApplicationClient {
  return { capabilities: { native: true }, getSnapshot: () => ({ ...EMPTY_SNAPSHOT, account: { ...account, userId: '', kdf: { kdf: 0, iterations: 1 } } }),
    connect: vi.fn(async () => {}), unlock: vi.fn(async () => {}), ...overrides } as unknown as ApplicationClient;
}
function destination(title: string) {
  expect(host.querySelectorAll('main')).toHaveLength(1);
  expect(host.querySelector('main main')).toBeNull();
  expect(host.querySelectorAll('h1')).toHaveLength(1);
  expect(host.querySelector('main h1')?.textContent).toBe(title);
}
async function mountConnect(value = client()) {
  await act(() => root.render(createElement(Connect, { client: value, onConnected: vi.fn() })));
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
it.each([false, true])('owns one main and h1 for Connect account pick/form (pick=%s)', async pick => {
  fixture.accounts = pick ? [account] : [];
  await mountConnect(); destination(pick ? '选择要登录的账户' : '登录你的保险库');
});
it('keeps restoring semantics until the deferred connection draft arrives', async () => {
  let release!: (value: null) => void;
  const draft = { load: () => new Promise<null>(resolve => { release = resolve; }), save: vi.fn(), clear: vi.fn() };
  await mountConnect(client({ connectionDraft: draft }));
  destination('登录你的保险库'); expect(host.textContent).toContain('正在恢复表单');
  await act(async () => { release(null); }); destination('登录你的保险库');
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
});
it.each(['certificate', 'two-factor'])('retains destination semantics during Connect %s', async kind => {
  const connect = vi.fn().mockRejectedValue(kind === 'certificate' ? { kind: 'certUntrusted' } : { kind: 'twoFactorRequired', providers: [0] });
  await mountConnect(client({ connect })); await submit();
  destination(kind === 'certificate' ? '确认服务器证书' : '两步验证');
  if (kind === 'two-factor') expect(document.activeElement).toBe(host.querySelector('[aria-label="验证码"]'));
  else expect(host.textContent).toContain('SYNTHETIC');
});
it('keeps the shared ConnectScreen composable and retains quick-password focus', async () => {
  await act(() => root.render(createElement(ConnectScreen, { accounts: [account], busy: false, error: null, challenge: null,
    onSubmit: vi.fn(), onTwoFactor: vi.fn() })));
  expect(host.querySelector('main')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('li button')!.click());
  expect(host.querySelectorAll('h1')).toHaveLength(1);
  expect(document.activeElement).toBe(host.querySelector('input[type="password"]'));
});
it('owns Unlock semantics and retains password and two-factor focus', async () => {
  await act(() => root.render(createElement(Unlock, { client: client({ unlock: vi.fn().mockRejectedValue({ kind: 'twoFactorRequired', providers: [0] }) }),
    onUnlocked: vi.fn(), onDisconnect: vi.fn() })));
  destination('解锁保险库');
  const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(document.activeElement).toBe(password);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'synthetic-password');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submit(); destination('两步验证，解锁保险库');
  expect(document.activeElement).toBe(host.querySelector('[aria-label="验证码"]'));
});
