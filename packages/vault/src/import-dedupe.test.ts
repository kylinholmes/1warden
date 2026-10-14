import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptString, makeUserKey } from '@1warden/crypto';
import type { CipherDto, FolderDto } from '@1warden/api';
import { VaultClient } from './client';
import { encryptCipher } from './encrypt';
import type { ImportedItem } from './import';
import { emptyBankAccount, emptyCard, emptyDriversLicense, emptyIdentity, emptyLogin, emptyPassport, emptySshKey, type VaultItem } from './model';
import type { StoredPasskey } from './passkey';
import { buildProfileItem } from './profile';
import { createImportMatcher } from './import-dedupe';
import { parseBitwardenJson } from './import-json';

const source = (change: Partial<ImportedItem> = {}): ImportedItem => ({
  name: 'Example', type: 'login', notes: 'private notes', folderName: null, favorite: false,
  login: { username: 'person', password: 'original secret', uri: 'https://example.test', totp: null },
  customFields: [], rowNumber: 2, ...change,
});
const target = (change: Partial<VaultItem> = {}): VaultItem => ({
  id: '', type: 'login', rawType: 1, name: 'Example', nameFailed: false, notes: 'private notes', notesFailed: false,
  folderId: null, favorite: false, reprompt: 0, createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null,
  wrappedKey: null, login: { ...emptyLogin(), username: 'person', password: 'original secret',
    uris: [{ uri: 'https://example.test', match: null }] },
  card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [], ...change,
});

async function fixture(initial: VaultItem[] = [], folderNames: string[] = []) {
  const key = makeUserKey();
  const server = {
    ciphers: [] as CipherDto[], folders: [] as FolderDto[], writes: [] as string[], syncs: 0,
    loseNextItemResponse: false, loseNextFolderResponse: false, failSync: false,
    onSync: () => {}, onWrite: () => {},
  };
  for (const [index, name] of folderNames.entries()) server.folders.push({
    id: `folder-${index}`, name: await encryptString(name, key), revisionDate: '2026-01-01',
  });
  for (const [index, item] of initial.entries()) server.ciphers.push({
    ...await encryptCipher(item, key, { archivedDate: item.archivedAt }),
    id: `existing-${index}`, creationDate: '2026-01-01', revisionDate: '2026-10-14',
    deletedDate: item.deletedAt, organizationId: item.preservation?.source.organizationId ?? null,
  } as CipherDto);
  const client = new VaultClient({ fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/sync') {
      server.syncs++;
      server.onSync();
      if (server.failSync) return new Response('offline', { status: 503 });
      return Response.json({ ciphers: server.ciphers, folders: server.folders });
    }
    if (init?.method !== 'POST' || !['/api/ciphers', '/api/folders'].includes(path)) throw new Error(`Unexpected fixture request ${path}`);
    server.writes.push(path);
    const body = JSON.parse(String(init.body));
    const dto = { ...body, id: `created-${server.writes.length}`, creationDate: '2026-10-14', revisionDate: '2026-10-14' };
    if (path === '/api/folders') {
      server.folders.push(dto);
      if (server.loseNextFolderResponse) { server.loseNextFolderResponse = false; throw new Error('connection lost'); }
    } else {
      server.ciphers.push(dto);
      if (server.loseNextItemResponse) { server.loseNextItemResponse = false; throw new Error('connection lost'); }
    }
    server.onWrite();
    return Response.json(dto);
  } });
  client.restore({ account: { serverUrl: 'https://fixture.invalid', email: 'fixture@example.test', userId: 'fixture',
    kdf: { kdf: 0, iterations: 1 } }, userKey: key, token: { accessToken: 'fixture-token' } as never,
    items: [], folders: [], syncVerified: true });
  return { client, server };
}

afterEach(() => vi.restoreAllMocks());

describe('resumable imports', () => {
  it('refreshes accepted writes with lost responses before retrying the same file', async () => {
    const { client, server } = await fixture();
    server.loseNextItemResponse = true;
    const items = [source(), source({ name: 'Second' })];
    const first = await client.importItems(items, undefined, [], { skipExisting: true });
    expect(first.created).toBe(1);
    expect(first.failed).toMatchObject([{ name: 'Example' }]);
    expect(client.getSession().items).toHaveLength(1);
    expect(await client.importItems(items, undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 2, failed: [] });
    expect(server.ciphers).toHaveLength(2);
    expect(server.syncs).toBe(2);
  });

  it('preserves the multiplicity of identical source records across retries', async () => {
    const { client, server } = await fixture([target()]);
    const duplicateFile = [source(), source({ rowNumber: 3 })];
    expect(await client.importItems(duplicateFile, undefined, [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 1, failed: [] });
    expect(await client.importItems(duplicateFile, undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 2, failed: [] });
    expect(server.ciphers).toHaveLength(2);
  });

  it.each([undefined, false])('creates deliberate duplicates when skipExisting is %s', async skipExisting => {
    const { client, server } = await fixture([target()]);
    expect(await client.importItems([source(), source()], undefined, [], skipExisting === undefined ? {} : { skipExisting }))
      .toEqual({ created: 2, skippedExisting: 0, failed: [] });
    expect(server.ciphers).toHaveLength(3);
    expect(server.syncs).toBe(0);
  });

  it.each([
    ['password', source({ login: { ...source().login!, password: 'different secret' } })],
    ['URI match', source({ login: { ...source().login!, uris: [{ uri: 'https://example.test', match: 3 }] } })],
    ['extra URI', source({ login: { ...source().login!, uris: [{ uri: 'https://example.test', match: null }, { uri: 'https://second.test', match: null }] } })],
    ['custom field', source({ customFields: [{ name: 'Code', value: 'another secret', type: 1 }] })],
    ['history', source({ passwordHistory: [{ password: 'previous secret', lastUsedDate: '2025-01-01' }] })],
    ['autofill', source({ login: { ...source().login!, autofillOnPageLoad: false } })],
    ['favorite', source({ favorite: true })],
    ['reprompt', source({ reprompt: 1 })],
    ['notes whitespace', source({ notes: 'private notes ' })],
    ['folder', source({ folderName: 'Work' })],
    ['archive state', source({ archivedAt: '2025-01-01' })],
  ] as const)('keeps same-name records with different %s', async (_label, changed) => {
    const { client, server } = await fixture([target()]);
    expect(await client.importItems([changed], undefined, [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 0, failed: [] });
    expect(server.ciphers).toHaveLength(2);
  });

  it('matches archived records and folders from the server rather than the active session', async () => {
    const { client, server } = await fixture([target({ folderId: 'folder-0', archivedAt: '2025-01-01' })], ['Work']);
    expect(await client.importItems([source({ folderName: 'Work', archivedAt: '2026-10-14',
      createdAt: '2000-01-01', updatedAt: '2001-01-01' })], undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 1, failed: [] });
    expect(server.writes).toEqual([]);
  });

  it('reuses folders whose create responses were lost', async () => {
    const { client, server } = await fixture();
    server.loseNextFolderResponse = true;
    const items = [source({ folderName: 'Work' })];
    expect((await client.importItems(items, undefined, [], { skipExisting: true })).failed).toHaveLength(2);
    expect(await client.importItems(items, undefined, [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 0, failed: [] });
    expect(server.folders).toHaveLength(1);
    expect(server.ciphers[0]?.folderId).toBe(server.folders[0]?.id);
  });

  it('does not match trash or organization records', async () => {
    const { client, server } = await fixture([target({ deletedAt: '2026-01-01' }), target()]);
    server.ciphers[1]!.organizationId = 'organization';
    expect(await client.importItems([source()], undefined, [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 0, failed: [] });
    expect(server.ciphers).toHaveLength(3);
  });

  it('reports skipped records in progress', async () => {
    const { client } = await fixture([target()]);
    const progress: number[][] = [];
    expect(await client.importItems([source(), source({ name: 'Second' })], (done, total) => progress.push([done, total]), [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 1, failed: [] });
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it('compares histories, linked fields and passkeys without their generated row identities or date formatting', async () => {
    const credential: StoredPasskey = { credentialId: 'credential', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
      keyValue: 'private-key', rpId: 'example.test', counter: '0', discoverable: 'true', creationDate: '2026-01-01T00:00:00Z' };
    const imported = source({ passwordHistory: [{ password: 'old', lastUsedDate: '2025-01-01T00:00:00Z' }],
      customFields: [{ name: 'Linked', value: '', type: 3, linkedId: 100 }],
      login: { ...source().login!, passwordRevisionDate: '2026-01-01T00:00:00Z', fido2Credentials: [credential] } });
    const existing = target({ passwordHistory: [{ password: 'old', lastUsedDate: '2025-01-01T00:00:00.000Z', sourceId: 'old-history-row' }],
      customFields: [{ name: 'Linked', value: '', type: 3, linkedId: 100, sourceId: 'old-field-row' }],
      login: { ...target().login!, passwordRevisionDate: '2026-01-01T00:00:00.000Z',
        fido2Credentials: [{ ...credential, creationDate: '2026-01-01T00:00:00.000Z', sourceId: 'old-passkey-row' }] } });
    const { client, server } = await fixture([existing]);
    const changedKey = { ...imported, login: { ...imported.login!, fido2Credentials: [{ ...credential, keyValue: 'different-private-key' }] } };
    const changedLink = { ...imported, customFields: [{ name: 'Linked', value: '', type: 3 as const, linkedId: 101 }] };
    const changedHistory = { ...imported, passwordHistory: [{ password: 'different-old', lastUsedDate: '2025-01-01T00:00:00Z' }] };
    expect(await client.importItems([imported], undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 1, failed: [] });
    for (const changed of [changedKey, changedLink, changedHistory]) {
      expect(await client.importItems([changed], undefined, [], { skipExisting: true }))
        .toEqual({ created: 1, skippedExisting: 0, failed: [] });
    }
    expect(await client.importItems([imported, changedKey, changedLink, changedHistory], undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 4, failed: [] });
    expect(server.ciphers).toHaveLength(4);
  });

  describe('passkey decoder normalization', () => {
    const credential = { credentialId: 'fixture-credential', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
      keyValue: 'fixture-private-key', rpId: 'example.test', counter: '0', discoverable: 'true', creationDate: '2026-01-01' };
    function passkeyFile(change: Record<string, string>) {
      return parseBitwardenJson(JSON.stringify({ encrypted: false, folders: [], items: [{
        type: 1, name: 'Passkey fixture', login: { fido2Credentials: [{ ...credential, ...change }] },
      }] })).items;
    }

    it.each(['rpName', 'userHandle', 'userName', 'userDisplayName'])('skips a repeated JSON import with empty %s', async field => {
      const { client, server } = await fixture();
      const items = passkeyFile({ [field]: '' });
      expect(await client.importItems(items, undefined, [], { skipExisting: true }))
        .toEqual({ created: 1, skippedExisting: 0, failed: [] });
      expect(await client.importItems(items, undefined, [], { skipExisting: true }))
        .toEqual({ created: 0, skippedExisting: 1, failed: [] });
      expect(server.ciphers).toHaveLength(1);
    });

    it('skips empty optional passkey fields when the accepted write response was lost', async () => {
      const { client, server } = await fixture();
      server.loseNextItemResponse = true;
      const items = passkeyFile({ rpName: '', userHandle: '', userName: '', userDisplayName: '' });
      const first = await client.importItems(items, undefined, [], { skipExisting: true });
      expect(first.created).toBe(0);
      expect(first.failed).toHaveLength(1);
      expect(client.getSession().items).toHaveLength(0);
      expect(await client.importItems(items, undefined, [], { skipExisting: true }))
        .toEqual({ created: 0, skippedExisting: 1, failed: [] });
      expect(server.ciphers).toHaveLength(1);
    });

    it.each(['keyType', 'keyAlgorithm', 'keyCurve', 'counter', 'discoverable'])('matches the decoder default for empty %s', async field => {
      const { client, server } = await fixture();
      const items = passkeyFile({ [field]: '' });
      await client.importItems(items, undefined, [], { skipExisting: true });
      expect(await client.importItems(items, undefined, [], { skipExisting: true }))
        .toEqual({ created: 0, skippedExisting: 1, failed: [] });
      expect(server.ciphers).toHaveLength(1);
    });

    it.each(['rpName', 'userHandle', 'userName', 'userDisplayName'])('keeps nonempty %s distinct, including whitespace', async field => {
      const { client, server } = await fixture();
      await client.importItems(passkeyFile({ [field]: '' }), undefined, [], { skipExisting: true });
      expect(await client.importItems(passkeyFile({ [field]: ' ' }), undefined, [], { skipExisting: true }))
        .toEqual({ created: 1, skippedExisting: 0, failed: [] });
      expect(server.ciphers).toHaveLength(2);
    });
  });

  it.each([
    ['card', { ...emptyCard(), number: '4111111111111111' }, { ...emptyCard(), number: '5555555555554444' }],
    ['identity', { ...emptyIdentity(), email: 'first@example.test' }, { ...emptyIdentity(), email: 'second@example.test' }],
    ['sshKey', { ...emptySshKey(), privateKey: 'first-key' }, { ...emptySshKey(), privateKey: 'second-key' }],
    ['bankAccount', { ...emptyBankAccount(), accountNumber: '12345' }, { ...emptyBankAccount(), accountNumber: '67890' }],
    ['driversLicense', { ...emptyDriversLicense(), licenseNumber: 'A123' }, { ...emptyDriversLicense(), licenseNumber: 'B456' }],
    ['passport', { ...emptyPassport(), passportNumber: 'E123' }, { ...emptyPassport(), passportNumber: 'E456' }],
  ] as const)('compares the complete %s type block across repeated imports', async (type, before, after) => {
    const { client, server } = await fixture();
    const original = source({ type, login: null, [type]: before });
    const changed = source({ type, login: null, [type]: after });
    await client.importItems([original], undefined, [], { skipExisting: true });
    expect(await client.importItems([changed], undefined, [], { skipExisting: true }))
      .toEqual({ created: 1, skippedExisting: 0, failed: [] });
    expect(await client.importItems([original, changed], undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 2, failed: [] });
    expect(server.ciphers).toHaveLength(2);
  });

  it('matches a secure note whose type defaults to zero', async () => {
    const { client, server } = await fixture([target({ type: 'secureNote', rawType: 2, login: null, secureNote: { type: 0 } })]);
    expect(await client.importItems([source({ type: 'secureNote', login: null })], undefined, [], { skipExisting: true }))
      .toEqual({ created: 0, skippedExisting: 1, failed: [] });
    expect(server.writes).toEqual([]);
  });

  it('never consumes internal profile records as existing import content', () => {
    const profile = buildProfileItem({ displayName: 'Fixture', avatarDataUrl: null });
    expect(createImportMatcher([profile], [])(profile, null)).toBe(false);
  });

  it.each(['network', 'cipher', 'folder'] as const)('aborts before every write when target %s data cannot be read', async failure => {
    const { client, server } = await fixture([target()], ['Work']);
    if (failure === 'network') server.failSync = true;
    if (failure === 'cipher') server.ciphers[0]!.name = 'invalid ciphertext';
    if (failure === 'folder') server.folders[0]!.name = 'invalid ciphertext';
    await expect(client.importItems([source({ folderName: 'New' })], undefined, [], { skipExisting: true })).rejects.toThrow();
    expect(server.writes).toEqual([]);
  });
});

describe('import source session boundaries', () => {
  it.each([null, 'Work'])('checks the source guard after encryption and before creating %s', async folderName => {
    const { client, server } = await fixture();
    let sourceUnlocked = true;
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      const encrypted = await encrypt(...args);
      sourceUnlocked = false;
      return encrypted;
    });
    const assertCurrent = () => { if (!sourceUnlocked) throw new Error('source locked'); };
    await expect(client.importItems([source({ folderName })], undefined, [], { assertCurrent })).rejects.toThrow('source locked');
    expect(server.writes).toEqual([]);
  });

  it('checks the source guard after the target snapshot resolves', async () => {
    const { client, server } = await fixture();
    let sourceUnlocked = true;
    server.onSync = () => { sourceUnlocked = false; };
    await expect(client.importItems([source()], undefined, [], { skipExisting: true,
      assertCurrent: () => { if (!sourceUnlocked) throw new Error('source locked'); },
    })).rejects.toThrow('source locked');
    expect(server.writes).toEqual([]);
  });

  it('stops after a write response when the source locks and does not publish stale data', async () => {
    const { client, server } = await fixture();
    let sourceUnlocked = true;
    server.onWrite = () => { sourceUnlocked = false; };
    await expect(client.importItems([source(), source({ name: 'Second' })], undefined, [], {
      assertCurrent: () => { if (!sourceUnlocked) throw new Error('source locked'); },
    })).rejects.toThrow('source locked');
    expect(server.ciphers).toHaveLength(1);
    expect(client.getSession().items).toEqual([]);
  });

  it('treats a rejected source guard as cancellation even if a later check would succeed', async () => {
    const { client, server } = await fixture();
    let rejectNextCheck = false;
    server.onWrite = () => { rejectNextCheck = true; };
    await expect(client.importItems([source(), source({ name: 'Second' })], undefined, [], {
      assertCurrent: () => {
        if (rejectNextCheck) { rejectNextCheck = false; throw new Error('source check rejected'); }
      },
    })).rejects.toThrow('source check rejected');
    expect(server.ciphers).toHaveLength(1);
    expect(client.getSession().items).toEqual([]);
  });

  it('rechecks source cancellation when the target snapshot fails', async () => {
    const { client, server } = await fixture();
    let sourceUnlocked = true;
    server.failSync = true;
    server.onSync = () => { sourceUnlocked = false; };
    await expect(client.importItems([source()], undefined, [], { skipExisting: true,
      assertCurrent: () => { if (!sourceUnlocked) throw new Error('source locked'); },
    })).rejects.toThrow('source locked');
    expect(server.writes).toEqual([]);
  });

  it('rechecks the target after an asynchronous source guard locks the target', async () => {
    const { client, server } = await fixture();
    await expect(client.importItems([source()], undefined, [], {
      assertCurrent: async () => { await Promise.resolve(); client.lock(); },
    })).rejects.toThrow(/取消|锁定/);
    expect(server.writes).toEqual([]);
  });
});
