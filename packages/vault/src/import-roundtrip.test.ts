import { expect, it } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultClient } from './client';
import { parseImport } from './import-dispatch';
import { createVaultExport } from './export';

it('persists imported passkeys, password history, linked fields and login settings through real encryption', async () => {
  const client = new VaultClient({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ ...body, id: 'created', creationDate: '2026-10-14', revisionDate: '2026-10-14' });
  } });
  client.restore({ account: { serverUrl: 'https://fixture.invalid', email: 'fixture@example.com', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: { accessToken: 'fixture-token' } as never, items: [], folders: [], syncVerified: true });
  const parsed = await parseImport(new TextEncoder().encode(JSON.stringify({ encrypted: false, folders: [], items: [{
    name: 'Fixture', type: 1, reprompt: 1, notes: ' leading whitespace ', archivedDate: '2025-12-01',
    fields: [{ name: 'Username', value: '', type: 3, linkedId: 100 }],
    passwordHistory: [{ password: ' old password ', lastUsedDate: '2025-01-01' }],
    login: { username: 'name', password: ' password ', passwordRevisionDate: '2026-01-01', autofillOnPageLoad: false,
      fido2Credentials: [{ credentialId: 'fixture-id', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
        keyValue: 'fixture-private-key', rpId: 'example.com', counter: '0', discoverable: 'true', creationDate: '2026-01-01' }] },
  }] })));
  expect(await client.importItems(parsed.items)).toEqual({ created: 1, failed: [] });
  const saved = client.getSession().items[0]!;
  expect(saved).toMatchObject({ reprompt: 1, notes: ' leading whitespace ', archivedAt: '2025-12-01',
    customFields: [{ type: 3, linkedId: 100 }], passwordHistory: [{ password: ' old password ', lastUsedDate: '2025-01-01' }],
    login: { password: ' password ', passwordRevisionDate: '2026-01-01', autofillOnPageLoad: false,
      fido2Credentials: [{ credentialId: 'fixture-id', keyValue: 'fixture-private-key' }] } });
});

it('restores empty folders from JSON even when the vault has no records', async () => {
  const exported = await createVaultExport({ items: [], format: 'json',
    folders: [{ id: 'empty', name: 'Empty folder', nameFailed: false, updatedAt: '' }] });
  const parsed = await parseImport(exported.bytes);
  expect(parsed.folderNames).toEqual(['Empty folder']);
  const client = new VaultClient({ fetchImpl: async (_url, init) => Response.json({
    ...JSON.parse(String(init?.body)), id: 'restored-folder', revisionDate: '2026-10-14',
  }) });
  client.restore({ account: { serverUrl: 'https://fixture.invalid', email: 'fixture@example.com', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: { accessToken: 'fixture-token' } as never, items: [], folders: [], syncVerified: true });
  expect(await client.importItems(parsed.items, undefined, parsed.folderNames)).toEqual({ created: 0, failed: [] });
  expect(client.getSession().folders).toMatchObject([{ name: 'Empty folder' }]);
});

it('reports folder creation failures and does not silently move dependent records to no folder', async () => {
  const client = new VaultClient({ fetchImpl: async () => new Response('Failed', { status: 400 }) });
  client.restore({ account: { serverUrl: 'https://fixture.invalid', email: 'fixture@example.com', userId: 'fixture', kdf: { kdf: 0, iterations: 1 } },
    userKey: makeUserKey(), token: { accessToken: 'fixture-token' } as never, items: [], folders: [], syncVerified: true });
  const parsed = await parseImport(new TextEncoder().encode(JSON.stringify({ encrypted: false,
    folders: [{ id: 'folder', name: 'Unavailable folder' }],
    items: [{ name: 'Dependent record', type: 2, folderId: 'folder', notes: 'Keep grouped' }],
  })));
  const result = await client.importItems(parsed.items, undefined, parsed.folderNames);
  expect(result.created).toBe(0);
  expect(result.failed).toContainEqual(expect.objectContaining({ name: '文件夹：Unavailable folder' }));
  expect(result.failed).toContainEqual(expect.objectContaining({ name: 'Dependent record' }));
  expect(client.getSession().items).toEqual([]);
});
