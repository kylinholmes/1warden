import { describe, expect, it } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { encryptCipher } from './encrypt';
import { VaultClient } from './client';
import { emptyLogin, type VaultItem } from './model';

const record = (): VaultItem => ({
  id: 'item', name: 'Account', nameFailed: false, type: 'login', rawType: 1,
  notes: 'private notes', notesFailed: false, folderId: null, favorite: true, reprompt: 0,
  createdAt: '2026-01-01', updatedAt: '2026-01-02', deletedAt: null, archivedAt: null, wrappedKey: null,
  login: { ...emptyLogin(), username: 'me', password: 'private-password' },
  card: null, identity: null, secureNote: null, sshKey: null,
  customFields: [{ name: 'PIN', value: 'private-field', type: 1, linkedId: null }],
  passwordHistory: [{ lastUsedDate: '2025-01-01', password: 'private-history' }], attachments: [],
});

async function fixture(options: { move?: () => Promise<Response>; readFails?: boolean } = {}) {
  const key = makeUserKey();
  const item = record();
  const encrypted = await encryptCipher(item, key, {});
  const calls: { url: string; method: string; body: unknown }[] = [];
  let folderId: string | null = null;
  let favorite = item.favorite;
  const client = new VaultClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/api/ciphers/move')) {
      const target = (calls.at(-1)!.body as { folderId: string | null }).folderId;
      const response = options.move ? await options.move() : new Response(null, { status: 204 });
      if (response.ok) folderId = target;
      return response;
    }
    if (String(url).endsWith('/api/ciphers/item')) {
      if (options.readFails) return new Response('unavailable', { status: 503 });
      return Response.json({ ...encrypted, id: 'item', folderId, favorite, creationDate: item.createdAt,
        revisionDate: '2026-01-03', deletedDate: null, archivedDate: null });
    }
    if (String(url).endsWith('/api/ciphers/item/partial')) {
      // Vaultwarden treats an omitted folderId as null, even when changing a favorite.
      const body = calls.at(-1)!.body as { folderId?: string | null; favorite: boolean };
      folderId = body.folderId ?? null; favorite = body.favorite;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  } });
  client.restore({ syncVerified: true,
    account: { email: 'test@example.invalid', serverUrl: 'https://vault.test', userId: 'u', kdf: { kdf: 0, iterations: 1 } },
    userKey: key, token: { accessToken: 'test-token' } as never, items: [item, { ...item, id: 'keep' }],
    folders: [{ id: 'work', name: 'Work', nameFailed: false, updatedAt: '' }],
  });
  return { client, calls, item, serverRecord: () => ({ folderId, favorite }) };
}

describe('single-record folder assignment', () => {
  it('changes only folder membership on the wire and reloads the new record revision', async () => {
    const { client, calls } = await fixture();
    await client.moveToFolder('item', 'work');
    expect(calls).toEqual([
      { url: 'https://vault.test/api/ciphers/move', method: 'POST', body: { folderId: 'work', ids: ['item'] } },
      { url: 'https://vault.test/api/ciphers/item', method: 'GET', body: null },
    ]);
    const saved = client.getSession().items[0]!;
    expect(saved.folderId).toBe('work');
    expect(saved.updatedAt).toBe('2026-01-03');
    expect(saved.login?.password).toBe('private-password');
    expect(saved.customFields[0]?.value).toBe('private-field');
    expect(saved.passwordHistory[0]?.password).toBe('private-history');
    expect(saved.favorite).toBe(true);
    expect(client.getSession().items[1]?.folderId).toBeNull();
    await client.moveToFolder('item', null);
    expect(client.getSession().items[0]?.folderId).toBeNull();
  });

  it('rejects missing records, unknown folders and locked sessions without making requests', async () => {
    const { client, calls } = await fixture();
    await expect(client.moveToFolder('missing', 'work')).rejects.toThrow();
    await expect(client.moveToFolder('item', 'missing')).rejects.toThrow();
    client.lock();
    await expect(client.moveToFolder('item', 'work')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('leaves membership unchanged when the server rejects the move', async () => {
    const { client } = await fixture({ move: async () => new Response('rejected', { status: 403 }) });
    await expect(client.moveToFolder('item', 'work')).rejects.toThrow();
    expect(client.getSession().items[0]?.folderId).toBeNull();
  });

  it('keeps confirmed membership and reports a failed record reload accurately', async () => {
    const { client } = await fixture({ readFails: true });
    await expect(client.moveToFolder('item', 'work')).rejects.toThrow(/已.*保存|已.*移动/);
    expect(client.getSession().items[0]?.folderId).toBe('work');
    expect(client.getSession().items[0]?.login?.password).toBe('private-password');
  });

  it('does not load or apply a response belonging to an account that was locked', async () => {
    let release!: () => void;
    let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const { client, calls } = await fixture({ move: async () => {
      started(); await new Promise<void>(resolve => { release = resolve; });
      return new Response(null, { status: 204 });
    } });
    const pending = client.moveToFolder('item', 'work');
    await sent; client.lock(); release();
    await expect(pending).rejects.toThrow();
    expect(client.getSession().items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('orders concurrent favorite and folder writes without losing confirmed membership or revision', async () => {
    let release!: () => void;
    let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const { client, calls, serverRecord } = await fixture({ move: async () => {
      started(); await new Promise<void>(resolve => { release = resolve; });
      return new Response(null, { status: 204 });
    } });
    const moving = client.moveToFolder('item', 'work');
    await sent;
    const favoriting = client.toggleFavorite('item');
    await new Promise(resolve => setTimeout(resolve, 0));
    const requestsWhileMoving = calls.slice();
    release();
    await Promise.all([moving, favoriting]);
    expect(requestsWhileMoving).toHaveLength(1);
    expect(client.getSession().items[0]?.folderId).toBe('work');
    expect(client.getSession().items[0]?.updatedAt).toBe('2026-01-03');
    expect(client.getSession().items[0]?.favorite).toBe(false);
    expect(serverRecord()).toEqual({ folderId: 'work', favorite: false });
  });
});
