import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT } from '../src/application/types';
import { TwoFactorRequiredError } from '@1warden/api';
import { serializeError } from './application-rpc';
import { twoFactorChallenge } from '../src/screens/auth-error';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
