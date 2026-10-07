import { describe, expect, it } from 'vitest';
import { decryptString, makeUserKey } from '@coffer/crypto';
import { VaultClient, type VaultClientState } from './client';
import { emptyLogin, type VaultItem } from './model';
import type { ImportedItem } from './import';

function item(name = 'Before'): VaultItem {
  return {
    id: 'item', name, nameFailed: false, type: 'login', rawType: 1,
    notes: 'private note', notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-02', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username: 'me', password: 'secret' },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], attachments: [], passwordHistory: [],
  };
}

const imported = (folderName: string | null): ImportedItem => ({
  name: 'Imported', type: 'login', folderName, favorite: false, notes: 'private note',
  login: { username: 'me', password: 'secret', uri: 'https://example.com', totp: null }, customFields: [], rowNumber: 1,
});

function state(name = 'Before'): VaultClientState {
  return {
    account: { serverUrl: 'https://vault.test', email: 'me@example.com', userId: 'user', kdf: { kdf: 0, iterations: 1000 } },
    userKey: makeUserKey(), token: { accessToken: 'token' } as VaultClientState['token'],
    items: [item(name)], folders: [],
  };
}

describe('write cancellation at the vault boundary', () => {
  const operations = {
    save: (client: VaultClient) => client.saveItem(item('Changed')),
    createFolder: (client: VaultClient) => client.createFolder('Work'),
    renameFolder: (client: VaultClient) => client.renameFolder('folder', 'Work'),
    import: (client: VaultClient) => client.importItems([imported(null)]),
    importWithFolder: (client: VaultClient) => client.importItems([imported('Work')]),
    uploadAttachment: (client: VaultClient) => client.uploadAttachment('item', 'secret.txt', new Uint8Array([1, 2, 3])),
  };

  it.each(Object.keys(operations) as (keyof typeof operations)[])('%s never sends ciphertext after lock interrupts its encryption', async (operation) => {
    const requests: string[] = [];
    const client = new VaultClient({ fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    client.restore(state());
    const writing = operations[operation](client);
    client.lock();
    await Promise.allSettled([writing]);
    expect(requests).toEqual([]);
    expect(client.getSession().status).toBe('locked');
  });

  it('discards an old save response after a different session has been restored', async () => {
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    let finish!: () => void;
    const client = new VaultClient({ fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      await new Promise<void>((resolve) => { finish = resolve; markSent(); });
      return new Response(JSON.stringify({ ...body, id: 'item', creationDate: '2026-01-01', revisionDate: '2026-01-03' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } });
    client.restore(state());
    const saving = client.saveItem(item('Old session write'));
    await sent;
    client.lock();
    client.restore(state('New session record'));
    finish();
    await expect(saving).rejects.toThrow();
    expect(client.getSession().items[0]?.name).toBe('New session record');
  });

  it('keeps a normal save decryptable and updates the active snapshot', async () => {
    const original = state();
    const client = new VaultClient({ fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(await decryptString(body.name, original.userKey)).toBe('Renamed');
      expect(await decryptString(body.login.password, original.userKey)).toBe('secret');
      return new Response(JSON.stringify({ ...body, id: 'item', creationDate: '2026-01-01', revisionDate: '2026-01-03' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } });
    client.restore(original);
    const saved = await client.saveItem(item('Renamed'));
    expect(saved.name).toBe('Renamed');
    expect(client.getSession().items[0]?.login?.password).toBe('secret');
    expect(original.userKey.encKey.some((value) => value !== 0)).toBe(true);
  });

  it('stops an import after lock instead of continuing with the next record', async () => {
    let writes = 0;
    const client = new VaultClient({ fetchImpl: async (_url, init) => {
      writes++;
      const body = JSON.parse(String(init?.body));
      client.lock();
      return new Response(JSON.stringify({ ...body, id: 'item', creationDate: '2026-01-01', revisionDate: '2026-01-03' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } });
    client.restore(state());
    await expect(client.importItems([imported(null), { ...imported(null), name: 'Second' }])).rejects.toThrow();
    expect(writes).toBe(1);
    expect(client.getSession().items).toEqual([]);
  });
});
