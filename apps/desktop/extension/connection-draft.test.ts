import { expect, it } from 'vitest';
import { createConnectionDraftStore } from './connection-draft';

it('restores a failed connection after the popup is recreated, without retaining the password', async () => {
  const data: Record<string, unknown> = {};
  const area = {
    async get(key: string) { return { [key]: structuredClone(data[key]) }; },
    async set(value: Record<string, unknown>) { Object.assign(data, structuredClone(value)); },
    async remove(key: string) { delete data[key]; },
  };
  const first = createConnectionDraftStore(area);
  await first.save({ serverUrl: 'https://vault.test', email: 'person@example.test',
    error: '连接失败', masterPassword: 'must-not-persist' } as Parameters<typeof first.save>[0]);
  const reopened = createConnectionDraftStore(area);
  expect(await reopened.load()).toEqual({
    serverUrl: 'https://vault.test', email: 'person@example.test', error: '连接失败',
  });
  expect(JSON.stringify(data)).not.toContain('must-not-persist');
  await reopened.clear();
  expect(await createConnectionDraftStore(area).load()).toBeNull();
});

it('restores a validated public return identity without retaining nested session credentials', async () => {
  const data: Record<string, unknown> = {};
  const area = {
    async get(key: string) { return { [key]: structuredClone(data[key]) }; },
    async set(value: Record<string, unknown>) { Object.assign(data, structuredClone(value)); },
    async remove(key: string) { delete data[key]; },
  };
  const store = createConnectionDraftStore(area);
  await store.save({ serverUrl: '', email: '', error: null,
    returnAccount: { serverUrl: ' https://VAULT.test/team/ ', email: ' Person@Example.test ',
      masterPassword: 'nested-must-not-persist', accessToken: 'token-must-not-persist' },
  } as Parameters<typeof store.save>[0]);
  expect(await createConnectionDraftStore(area).load()).toEqual({
    serverUrl: '', email: '', error: null,
    returnAccount: { serverUrl: 'https://vault.test/team', email: 'person@example.test' },
  });
  expect(JSON.stringify(data)).not.toContain('must-not-persist');
});

it('drops invalid return identities read from storage while preserving the failed form', async () => {
  const store = createConnectionDraftStore({
    async get(key: string) { return { [key]: {
      serverUrl: 'https://draft.test', email: 'person@example.test', error: '连接失败',
      returnAccount: { serverUrl: 'javascript:alert(1)', email: 'person@example.test' },
    } }; },
    async set() {},
    async remove() {},
  });
  expect(await store.load()).toEqual({ serverUrl: 'https://draft.test', email: 'person@example.test', error: '连接失败' });
});
