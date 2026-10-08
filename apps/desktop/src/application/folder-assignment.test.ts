import { describe, expect, it } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultClient, emptyLogin, encryptCipher, type VaultItem } from '@1warden/vault';
import { createApplicationClient } from './client';
import { createVaultService } from './service';
import { createAndAssignFolder, pendingFolderAssignment } from './folder-assignment';

async function fixture() {
  const key = makeUserKey();
  const item: VaultItem = {
    id: 'original-item', name: 'Account', nameFailed: false, type: 'login', rawType: 1,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-02', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), password: 'private-password' }, card: null, identity: null,
    secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [],
  };
  const encrypted = await encryptCipher(item, key, {});
  let folderId: string | null = null;
  let rejectMove = false;
  let creates = 0;
  const requests: { url: string; method: string; body: unknown }[] = [];
  const vault = new VaultClient({ fetchImpl: async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), method: init?.method ?? 'GET', body });
    if (String(url).endsWith('/api/folders')) {
      creates++;
      return Response.json({ id: 'authoritative-folder-id', name: body.name, revisionDate: '2026-01-03' });
    }
    if (String(url).endsWith('/api/ciphers/move')) {
      if (rejectMove) return new Response('offline', { status: 503 });
      folderId = body.folderId;
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith('/api/ciphers/original-item')) {
      return Response.json({ ...encrypted, id: item.id, folderId, creationDate: item.createdAt, revisionDate: '2026-01-04' });
    }
    throw new Error(`Unexpected request ${url}`);
  } });
  vault.restore({ syncVerified: true, userKey: key,
    account: { email: 'me@vault.test', serverUrl: 'https://vault.test', userId: 'u', kdf: { kdf: 0, iterations: 1 } },
    token: { accessToken: 'test-token' } as never, items: [item], folders: [],
  });
  const client = createApplicationClient(createVaultService(vault), {
    capabilities: { native: false, browser: false, saveAttachments: false }, saveFile: async () => ({ path: null }),
  });
  await client.initialize();
  return { client, requests, creates: () => creates, rejectMove: (value: boolean) => { rejectMove = value; } };
}

describe('create and assign folder', () => {
  it('returns the created folder from the application service and client', async () => {
    const { client, requests } = await fixture();
    await expect(client.createFolder('  ')).rejects.toThrow(/名称/);
    expect(requests).toEqual([]);
    expect(await client.createFolder(' Work ')).toMatchObject({ id: 'authoritative-folder-id', name: 'Work' });
    client.dispose();
  });

  it('trims the name and assigns the original item after the folder snapshot replaces the detail', async () => {
    const { client, requests } = await fixture();
    let detailMounted = true;
    let operationAfterRemount: Promise<unknown> | undefined;
    const stopDetail = client.subscribe(() => {
      if (client.getSnapshot().folders.length) {
        detailMounted = false; stopDetail();
        operationAfterRemount = pendingFolderAssignment(client, 'original-item');
      }
    });
    expect(await createAndAssignFolder(client, 'original-item', '  Work  ')).toMatchObject({ id: 'authoritative-folder-id', name: 'Work' });
    expect(detailMounted).toBe(false);
    expect(operationAfterRemount).toBeInstanceOf(Promise);
    await operationAfterRemount;
    expect(pendingFolderAssignment(client, 'original-item')).toBeUndefined();
    expect(client.getSnapshot().items[0]?.folderId).toBe('authoritative-folder-id');
    expect(requests.find(request => request.url.endsWith('/move'))?.body).toEqual({ ids: ['original-item'], folderId: 'authoritative-folder-id' });
    client.dispose();
  });

  it('rejects empty names before creating anything', async () => {
    const { client, requests } = await fixture();
    await expect(createAndAssignFolder(client, 'original-item', ' \n ')).rejects.toThrow(/名称/);
    expect(requests).toEqual([]);
    client.dispose();
  });

  it('retains the created folder after assignment fails and retries assignment without another creation', async () => {
    const { client, requests, creates, rejectMove } = await fixture();
    rejectMove(true);
    await expect(createAndAssignFolder(client, 'original-item', 'Work')).rejects.toThrow(/已创建.*归类/);
    expect(client.getSnapshot().folders[0]?.id).toBe('authoritative-folder-id');
    expect(client.getSnapshot().items[0]?.folderId).toBeNull();
    rejectMove(false);
    await createAndAssignFolder(client, 'original-item', ' Work ');
    expect(creates()).toBe(1);
    expect(client.getSnapshot().items[0]?.folderId).toBe('authoritative-folder-id');
    expect(requests.some(request => request.method === 'DELETE')).toBe(false);
    client.dispose();
  });

  it.each(['lock', 'switch'] as const)('does not assign after %s triggered by the created folder snapshot', async (boundary) => {
    const { client, requests } = await fixture();
    let crossing: Promise<void> | undefined;
    const stop = client.subscribe(() => {
      if (client.getSnapshot().folders.length && !crossing) {
        stop();
        crossing = boundary === 'lock' ? client.lock() : client.switchAccount({ email: 'other@vault.test', serverUrl: 'https://vault.test' });
      }
    });
    await expect(createAndAssignFolder(client, 'original-item', 'Work')).rejects.toThrow(/已创建.*归类/);
    await crossing;
    expect(requests.some(request => request.url.endsWith('/move'))).toBe(false);
    client.dispose();
  });
});
