import { describe, expect, it } from 'vitest';
import { encryptString, makeUserKey } from '@1warden/crypto';
import { VaultClient } from './client';
import { emptyLogin, type VaultItem } from './model';

async function fixture() {
  const key = makeUserKey();
  const before: VaultItem = { id: 'item', type: 'login', rawType: 1, name: 'Before', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T01:00:00Z', deletedAt: null, archivedAt: null,
    wrappedKey: null, login: { ...emptyLogin(), username: 'test-user', password: 'test-secret' },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], attachments: [], passwordHistory: [] };
  let record: Record<string, unknown> = { id: 'item', type: 1, name: await encryptString(before.name, key),
    login: { username: await encryptString('test-user', key), password: await encryptString('test-secret', key) },
    creationDate: before.createdAt, revisionDate: before.updatedAt };
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let reads = 0; let retryFails = false;
  const client = new VaultClient({ fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/accounts/revision-date') return Response.json(42);
    if (path === '/api/sync') {
      reads++;
      const captured = structuredClone(record);
      if (reads === 1) { entered(); await paused; }
      else if (retryFails) return Response.json({}, { status: 503 });
      return Response.json({ profile: {}, folders: [], ciphers: [captured], collections: [] });
    }
    if (path === '/api/ciphers/item' && init?.method === 'PUT') {
      record = { ...JSON.parse(String(init.body)), id: 'item', creationDate: before.createdAt, revisionDate: '2026-10-09T02:00:00Z' };
      return Response.json(record);
    }
    throw Error(`Unexpected fixture request: ${path}`);
  } });
  client.restore({ account: { serverUrl: 'https://fixture.test', email: 'test@example.com', userId: 'user', kdf: { kdf: 0, iterations: 1 } },
    userKey: key, token: { accessToken: 'test-token' } as never, items: [before], folders: [], syncVerified: true });
  return { client, before, started, release, readCount: () => reads, failRetry: () => { retryFails = true; } };
}

describe('sync racing a committed local write', () => {
  it('discards a late old response, fetches again, and never publishes it over the acknowledged edit', async () => {
    const { client, before, started, release, readCount } = await fixture();
    const syncing = client.refresh();
    await started;
    await client.saveItem({ ...before, name: 'After' });
    expect(client.getSession().items[0]?.name).toBe('After');
    release(); await syncing;
    expect(client.getSession().items[0]?.name).toBe('After');
    expect(readCount()).toBe(2);
    expect(client.hasVerifiedSync()).toBe(true);
  });

  it('retains the acknowledged edit and exposes failure when the required fresh request fails', async () => {
    const { client, before, started, release, failRetry } = await fixture();
    const syncing = client.refresh();
    const failed = expect(syncing).rejects.toThrow(/同步失败/);
    await started;
    await client.saveItem({ ...before, name: 'After' });
    failRetry(); release(); await failed;
    expect(client.getSession().items[0]?.name).toBe('After');
    expect(client.syncError).toMatch(/同步失败/);
    expect(client.hasVerifiedSync()).toBe(false);
  });

  it('does not retry or publish stale data after a lock interrupts the race', async () => {
    const { client, before, started, release, readCount } = await fixture();
    const syncing = client.refresh();
    await started;
    await client.saveItem({ ...before, name: 'After' });
    client.lock(); release(); await syncing;
    expect(client.getSession().items).toEqual([]);
    expect(readCount()).toBe(1);
    expect(client.hasVerifiedSync()).toBe(false);
    expect(client.syncError).toBeNull();
  });
});
