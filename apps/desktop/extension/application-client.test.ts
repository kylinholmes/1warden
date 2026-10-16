import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT } from '../src/application/types';
import { TwoFactorRequiredError } from '@1warden/api';
import { serializeError } from './application-rpc';
import { twoFactorChallenge } from '../src/screens/auth-error';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['#capture=expired', '#capture=%65xpired'])('recovers from an expired review link %s on Retry', async hash => {
  vi.resetModules();
  const location = { hash, pathname: '/popup.html', search: '' };
  const requests: { captureId?: string }[] = [];
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { replaceState() { location.hash = ''; } });
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: { sendMessage: async (request: { captureId?: string }) => {
    requests.push(request);
    return request.captureId ? { ok: false, error: { kind: 'captureExpired', message: '已过期，请重试' } }
      : { ok: true, result: [{ id: 'fresh' }] };
  } } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await expect(client.browser!.credentials!.list()).rejects.toThrow('已过期');
  expect(location.hash).toBe('');
  expect(await client.browser!.credentials!.list()).toEqual([{ id: 'fresh' }]);
  expect(requests[1]!.captureId).toBeUndefined();
});
it('retains review links on network failures and never removes a newer link', async () => {
  vi.resetModules();
  const location = { hash: '#capture=old', pathname: '/popup.html', search: '' };
  vi.stubGlobal('location', location);
  const replaceState = vi.fn(); vi.stubGlobal('history', { replaceState });
  const sendMessage = vi.fn().mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'offline' } })
    .mockImplementationOnce(async () => { location.hash = '#capture=new'; return { ok: false, error: { kind: 'captureExpired', message: 'expired' } }; });
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: { sendMessage } });
  const { createExtensionApplicationClient } = await import('./application-client'); const client = createExtensionApplicationClient();
  await expect(client.browser!.credentials!.list()).rejects.toThrow('offline'); expect(location.hash).toBe('#capture=old');
  await expect(client.browser!.credentials!.list()).rejects.toThrow('expired'); expect(location.hash).toBe('#capture=new');
  expect(replaceState).not.toHaveBeenCalled();
});

it('routes an explicit capture review and clears its link only after successful confirmation', async () => {
  vi.resetModules();
  const send = vi.fn(async () => ({ ok: true, result: [] }));
  const location = { hash: '#capture=one', pathname: '/popup.html', search: '' };
  const replaceState = vi.fn(() => { location.hash = ''; });
  vi.stubGlobal('location', location); vi.stubGlobal('history', { replaceState });
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: { sendMessage: send } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await client.browser!.credentials!.list();
  expect(send).toHaveBeenCalledWith({ type: '1warden:credential-list', application: true, captureId: 'one' });
  const choice = { captureId: 'one', revision: 1, action: 'save' as const };
  send.mockRejectedValueOnce(new Error('offline'));
  await expect(client.browser!.credentials!.save(choice)).rejects.toThrow('offline');
  expect(replaceState).not.toHaveBeenCalled();
  await client.browser!.credentials!.save(choice);
  expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/popup.html');
  await client.browser!.credentials!.list();
  expect(send).toHaveBeenLastCalledWith({ type: '1warden:credential-list', application: true });
  client.dispose();
});

it('forwards only merge IDs, preview tokens and explicit choices through the bridge', async () => {
  vi.resetModules();
  const send = vi.fn(async (request: { method: string; args: unknown[] }) => ({ ok: true,
    result: request.method === 'mergeItems' ? { baseId: 'base', saved: true, trashedIds: ['source'], retainedSources: [] }
      : request.method === 'revealMergeValue' ? 'explicit-secret' : request.method === 'previewMerge' ? { token: 'opaque' } : EMPTY_SNAPSHOT }));
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: { sendMessage: send } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await expect(client.previewMerge({ baseId: 'base', sourceIds: ['source'] })).resolves.toEqual({ token: 'opaque' });
  await expect(client.revealMergeValue({ token: 'opaque', fieldKey: 'password', itemId: 'source' })).resolves.toBe('explicit-secret');
  await expect(client.mergeItems({ token: 'opaque', choices: { password: 'source' } })).resolves.toMatchObject({ saved: true });
  expect(send.mock.calls.map(call => call[0])).toEqual([
    { type: '1warden:application', method: 'previewMerge', args: [{ baseId: 'base', sourceIds: ['source'] }] },
    { type: '1warden:application', method: 'revealMergeValue', args: [{ token: 'opaque', fieldKey: 'password', itemId: 'source' }] },
    { type: '1warden:application', method: 'mergeItems', args: [{ token: 'opaque', choices: { password: 'source' } }] },
    { type: '1warden:application', method: 'snapshot', args: [] },
  ]);
  client.dispose();
});

it('sends the organization report as a no-argument read without refreshing or mutating', async () => {
  vi.resetModules();
  const report = { total: 1, checked: 1, skipped: 0, duplicates: [], missingUrls: ['fixture-id'], missingUsernames: [], lowInformationNames: [], unfiled: [] };
  const send = vi.fn(async (request: { method: string; args: unknown[] }) => ({ ok: true, result: request.method === 'organizationReport' ? report : EMPTY_SNAPSHOT }));
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: { sendMessage: send } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await expect(client.organizationReport()).resolves.toEqual(report);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: '1warden:application', method: 'organizationReport', args: [] });
  client.dispose();
});

it('preserves the folder ID returned by the background for create and assign', async () => {
  vi.resetModules();
  const folder = { id: 'server-folder-id', name: 'Work', nameFailed: false, updatedAt: '2026-10-09' };
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    sendMessage: async (request: { method: string }) => ({ ok: true, result: request.method === 'createFolder' ? folder : EMPTY_SNAPSHOT }),
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await expect(client.createFolder('Work')).resolves.toEqual(folder);
  client.dispose();
});

it('prepares Add Account return identity before publishing the connection page', async () => {
  vi.resetModules();
  const account = { serverUrl: 'https://vault.test', email: 'me@example.com', userId: 'u', kdf: { kdf: 0 as const, iterations: 1 } };
  const data: Record<string, unknown> = {};
  const prepared: unknown[] = [];
  let finish!: () => void;
  vi.stubGlobal('chrome', { storage: { session: {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, values); },
    remove: async (key: string) => { delete data[key]; },
  } }, runtime: {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: async (request: { method: string }) => {
      if (request.method === 'switchAccount') await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, result: { ...EMPTY_SNAPSHOT, status: 'unlocked', account } };
    },
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient(); await client.initialize();
  client.subscribe(() => { if (client.getSnapshot().status === 'loggedOut') prepared.push(structuredClone(data['1warden.connectionDraft'])); });
  const selecting = client.switchAccount(null);
  await vi.waitFor(() => { expect(finish).toBeTypeOf('function'); });
  expect(prepared).toEqual([{ serverUrl: '', email: '', error: null, returnAccount: { serverUrl: account.serverUrl, email: account.email } }]);
  finish(); await selecting; client.dispose();
});

it('finishes startup with a retryable error if the background never responds', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let respond = false;
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: () => respond ? Promise.resolve({ ok: true, result: EMPTY_SNAPSHOT }) : new Promise(() => {}),
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  let result = 'pending';
  const loading = client.initialize().then(() => { result = 'ready'; }, () => { result = 'failed'; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(result).toBe('failed');
  await loading;
  respond = true;
  await client.initialize();
  expect(client.getSnapshot().status).toBe('loggedOut');
  client.dispose();
});

it.each(['search', 'getItem'] as const)('%s times out instead of leaving the interface spinning forever', async (method) => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    sendMessage: () => new Promise(() => {}),
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  const pending = expect(client[method]('github')).rejects.toThrow('扩展后台响应超时，请重试');
  await vi.advanceTimersByTimeAsync(5_000);
  await pending; client.dispose();
});

it('explains a missing background receiver and allows an explicit startup retry', async () => {
  vi.resetModules();
  const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
    .mockResolvedValue({ ok: true, result: EMPTY_SNAPSHOT });
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    onMessage: { addListener() {}, removeListener() {} }, sendMessage,
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await expect(client.initialize()).rejects.toThrow(/扩展后台.*重试/);
  await client.initialize();
  expect(client.getSnapshot().status).toBe('loggedOut');
  client.dispose();
});

it('preserves the structured two-factor challenge through the UI client', async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    sendMessage: async (request: { method: string }) => request.method === 'snapshot'
      ? { ok: true, result: EMPTY_SNAPSHOT }
      : { ok: false, error: serializeError(new TwoFactorRequiredError([0], { 0: null }, {})) },
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  const error = await client.connect({ serverUrl: 'https://vault.test', email: 'me@example.com', masterPassword: 'test' }).catch((value: unknown) => value);
  expect(error).toMatchObject({ kind: 'twoFactorRequired', providers: [0], providersInfo: { 0: null } });
  expect(twoFactorChallenge(error)).toEqual({ providers: [0], providersInfo: { 0: null } });
});

it('does not refresh the displayed vault on a content script forged change notification', async () => {
  vi.resetModules();
  let onMessage!: (message: unknown, sender: chrome.runtime.MessageSender) => void;
  let revision = 1;
  vi.stubGlobal('chrome', { storage: { session: {} }, runtime: {
    id: 'onewarden-id',
    onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; }, removeListener: () => {} },
    sendMessage: async () => ({ ok: true, result: { ...EMPTY_SNAPSHOT, revision } }),
  } });
  const { createExtensionApplicationClient } = await import('./application-client');
  const client = createExtensionApplicationClient();
  await client.initialize();
  revision = 2;
  onMessage({ type: '1warden-internal:changed' }, { id: 'onewarden-id', url: 'https://example.com', tab: { id: 1 } as chrome.tabs.Tab });
  // Allow the request chain to finish if the notification was mistakenly accepted.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.getSnapshot().revision).toBe(1);
  onMessage({ type: '1warden-internal:changed' }, { id: 'onewarden-id' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.getSnapshot().revision).toBe(2);
  client.dispose();
});
