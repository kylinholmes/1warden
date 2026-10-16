import { afterEach, expect, it } from 'vitest';
import { installHost, resetHost } from '@1warden/ui';
import { EMPTY_SNAPSHOT } from './application/types';
import { loadQuickAccounts, createQuickAccountNavigation } from './quick-accounts';

afterEach(() => resetHost());
it('loads canonical remembered identities in saved order and projects only cached presentation data', async () => {
  const saved = [{ serverUrl: 'https://two.example/', email: 'TWO@example.test' },
    { serverUrl: 'https://one.example', email: 'one@example.test' },
    { serverUrl: 'https://two.example', email: 'two@example.test' }, { serverUrl: 'file:///invalid', email: 'x@example.test' }];
  installHost({ fetch, storage: { get: async key => key === '1warden.accounts' ? JSON.stringify(saved)
    : key.startsWith('profile.v1.') ? JSON.stringify({ displayName: 'Name', avatarDataUrl: null, secret: 'never publish' }) : null,
    set: async () => {}, remove: async () => {} } });
  const result = await loadQuickAccounts(EMPTY_SNAPSHOT);
  expect(result.map(account => account.email)).toEqual(['two@example.test', 'one@example.test']);
  expect(result[0]).toEqual({ id: '["https://two.example","two@example.test"]', serverUrl: 'https://two.example', email: 'two@example.test', displayName: 'Name', avatarDataUrl: null });
  expect(JSON.stringify(result)).not.toContain('never publish');
});
it('keeps an active unsaved account available and honors a freshly removed avatar', async () => {
  installHost({ fetch, storage: { get: async key => key.startsWith('profile.v1.') ? JSON.stringify({ displayName: 'Old', avatarDataUrl: 'old' }) : null,
    set: async () => {}, remove: async () => {} } });
  const accounts = await loadQuickAccounts({ ...EMPTY_SNAPSHOT, account: { serverUrl: 'https://active.example', email: 'active@example.test', userId: 'id', kdf: { kdf: 0, iterations: 1000 } },
    profileReady: true, profile: { displayName: 'Current', avatarDataUrl: null } });
  expect(accounts).toHaveLength(1); expect(accounts[0]).toMatchObject({ displayName: 'Current', avatarDataUrl: null });
});
it('routes a request only while the main application has a live navigation handler', async () => {
  const navigation = createQuickAccountNavigation(); const selected: unknown[] = [];
  await expect(navigation.open(null)).rejects.toThrow();
  const stop = navigation.subscribe(async target => { selected.push(target); });
  const target = { email: 'one@example.test', serverUrl: 'https://one.example' };
  await navigation.open(target); expect(selected).toEqual([target]);
  stop(); await expect(navigation.open(target)).rejects.toThrow();
});
it('carries the cancellation guard through to the application navigation save boundary', async () => {
  const navigation = createQuickAccountNavigation(); let cancelled = false; let switched = false;
  navigation.subscribe(async (_target, assertCurrent) => {
    cancelled = true; await assertCurrent?.(); switched = true;
  });
  await expect(navigation.open(null, async () => { if (cancelled) throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(switched).toBe(false);
});
it('uses the authoritative selected vault during a switch before its application snapshot refreshes', async () => {
  installHost({ fetch, storage: { get: async () => null, set: async () => {}, remove: async () => {} } });
  const previous = { serverUrl: 'https://previous.example', email: 'previous@example.test', userId: '', kdf: { kdf: 0 as const, iterations: 1000 } };
  const active = { serverUrl: 'https://active.example', email: 'active@example.test' };
  const accounts = await loadQuickAccounts({ ...EMPTY_SNAPSHOT, account: previous, profileReady: true,
    profile: { displayName: 'Previous profile', avatarDataUrl: null } }, active);
  expect(accounts).toHaveLength(1); expect(accounts[0]).toMatchObject({ ...active, displayName: '' });
});
