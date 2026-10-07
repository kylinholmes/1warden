import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VaultClient, buildProfileItem, emptyLogin } from '@coffer/vault';
import { makeUserKey } from '@coffer/crypto';
import { installClipboardScheduler } from '@coffer/ui';
import { useQuickBridge } from './use-quick-bridge';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  replies: [] as Array<{ event: string; payload: unknown }>,
  cleanup: null as (() => void) | null,
  onReply: null as ((event: string) => void) | null,
}));
vi.mock('react', async (importOriginal) => ({ ...await importOriginal<typeof import('react')>(),
  useEffect(effect: () => (() => void) | undefined) { harness.cleanup = effect() ?? null; },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    harness.handlers.set(event, handler); return () => { harness.handlers.delete(event); };
  },
  emitTo: async (_target: string, event: string, payload: unknown) => {
    harness.replies.push({ event, payload }); harness.onReply?.(event);
  },
}));

const vaults: VaultClient[] = [];
function vault(label: string) {
  const client = new VaultClient({ fetchImpl: async () => { throw Error('Unexpected network'); } });
  client.restore({ account: { serverUrl: `https://${label.toLowerCase()}.example`, email: 'user@example.com',
    userId: label, kdf: { kdf: 0, iterations: 1000 } }, token: null, userKey: makeUserKey(),
    items: [{ ...buildProfileItem({ displayName: '', avatarDataUrl: null }), id: `login-${label}`,
      name: `Login ${label}`, notes: null, customFields: [], type: 'login', rawType: 1,
      login: { ...emptyLogin(), username: `username-${label}`, password: `password-${label}`, totp: 'JBSWY3DPEHPK3PXP' } }], folders: [],
  });
  vaults.push(client); return client;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => { harness.handlers.clear(); harness.replies.length = 0; harness.onReply = null; installClipboardScheduler(async () => {}); });
afterEach(() => {
  harness.cleanup?.(); harness.cleanup = null;
  for (const client of vaults.splice(0)) client.logout();
  installClipboardScheduler(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('queries and copies from the current account after a retained-session switch', async () => {
  const clientA = vault('A'); const clientB = vault('B'); let active = clientA;
  const listeners = new Set<() => void>();
  const copied: string[] = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { copied.push(text); } } });
  useQuickBridge(() => active, (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  harness.handlers.get('coffer:query')!({ payload: { query: '', seq: 3 } });
  expect(harness.replies.at(-1)?.payload).toMatchObject({ seq: 3, serverUrl: 'https://a.example', items: [{ id: 'login-A' }] });
  active = clientB; for (const listener of listeners) listener();
  expect(harness.replies.at(-1)?.payload).toMatchObject({ seq: 3, serverUrl: 'https://b.example', items: [{ id: 'login-B' }] });
  expect(JSON.stringify(harness.replies)).not.toContain('password-A');
  expect(JSON.stringify(harness.replies)).not.toContain('password-B');
  expect(JSON.stringify(harness.replies)).not.toContain('JBSWY3DPEHPK3PXP');
  const replied = deferred(); harness.onReply = (event) => { if (event === 'coffer:action-result') replied.resolve(); };
  harness.handlers.get('coffer:action')!({ payload: { itemId: 'login-B', action: 'copy-password' } });
  await replied.promise;
  expect(copied).toEqual(['password-B']);
  expect(clientA.isUnlocked()).toBe(true);
});

it('cancels a pending OTP across A → B → A even though A remains unlocked', async () => {
  const clientA = vault('A'); const clientB = vault('B'); let active = clientA;
  const listeners = new Set<() => void>();
  const copied: string[] = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { copied.push(text); } } });
  const started = deferred(); const release = deferred(); const replied = deferred();
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
    started.resolve(); await release.promise; return sign(...args);
  });
  harness.onReply = (event) => { if (event === 'coffer:action-result') replied.resolve(); };
  useQuickBridge(() => active, (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  harness.handlers.get('coffer:action')!({ payload: { itemId: 'login-A', action: 'copy-totp' } });
  await started.promise;
  active = clientB; for (const listener of listeners) listener();
  active = clientA; for (const listener of listeners) listener();
  release.resolve(); await replied.promise;
  expect(clientA.isUnlocked()).toBe(true);
  expect(copied).toEqual([]);
  expect(harness.replies.at(-1)?.payload).toMatchObject({ ok: false });
});

it('does not copy an OTP that finishes after the selected session locks', async () => {
  const client = vault('A');
  const copied: string[] = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { copied.push(text); } } });
  const started = deferred(); const release = deferred(); const replied = deferred();
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
    started.resolve(); await release.promise; return sign(...args);
  });
  harness.onReply = replied.resolve;
  useQuickBridge(client);
  harness.handlers.get('coffer:action')!({ payload: { itemId: 'login-A', action: 'copy-totp' } });
  await started.promise; client.lock(); release.resolve(); await replied.promise;
  expect(copied).toEqual([]);
  expect(harness.replies.at(-1)?.event).toBe('coffer:action-result');
  expect(harness.replies.at(-1)?.payload).toMatchObject({ ok: false });
});
