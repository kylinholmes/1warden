import { expect, it } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultClient } from './client';
import { encryptCipher } from './encrypt';
import { emptyLogin, type VaultItem } from './model';

const item: VaultItem = { id: '', type: 'login', rawType: 1, name: 'Archived credential', nameFailed: false,
  notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0, createdAt: '', updatedAt: '',
  deletedAt: null, archivedAt: '2026-01-01T00:00:00Z', wrappedKey: null, login: { ...emptyLogin(), password: 'archived-secret' },
  card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
async function fixture() {
  const key = makeUserKey();
  const body = await encryptCipher(item, key, { archivedDate: item.archivedAt });
  const archived = { ...body, id: 'archive', creationDate: '2026-01-01', revisionDate: '2026-01-02' };
  let release!: () => void; let delayed = false;
  const client = new VaultClient({ fetchImpl: async input => {
    expect(String(input)).toContain('/sync');
    if (delayed) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ ciphers: [archived, { ...archived, id: 'trash', deletedDate: '2026-02-01T00:00:00Z' },
      { ...archived, id: 'organization', organizationId: 'organization', name: 'unreadable organization ciphertext' }], folders: [] });
  } });
  client.restore({ account: { serverUrl: 'https://fixture.invalid', email: 'fixture@example.com', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: key, token: { accessToken: 'fixture-token' } as never, items: [], folders: [], syncVerified: true });
  return { client, delay: () => { delayed = true; }, release: () => release() };
}
it('reads a complete export snapshot including archives absent from the active session', async () => {
  const { client } = await fixture();
  expect(client.getSession().items).toHaveLength(0);
  const data = await client.readExportData();
  expect(data.items).toHaveLength(1);
  expect(data.items[0]).toMatchObject({ id: 'archive', archivedAt: '2026-01-01T00:00:00Z', login: { password: 'archived-secret' } });
  expect(data.organizationItems).toBe(1);
  expect(client.getSession().items).toHaveLength(0);
});
it('discards an authoritative export snapshot when locking while the server responds', async () => {
  const { client, delay, release } = await fixture(); delay();
  const pending = client.readExportData(); const rejected = expect(pending).rejects.toThrow(/锁定|取消/);
  await new Promise(resolve => setTimeout(resolve, 0)); client.lock(); release(); await rejected;
});
