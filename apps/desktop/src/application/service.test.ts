import type { CipherDto } from '@1warden/api';
import { describe, expect, it, vi } from 'vitest';
import { VaultClient, decryptCipher, emptyLogin, emptyIdentity, buildProfileItem, buildPreferencesItem, parseProfileSettings, type VaultItem } from '@1warden/vault';
import { concatBytes, deriveMasterKey, encryptBytes, encryptString, decryptString, makeUserKey, stretchMasterKey } from '@1warden/crypto';
import { createVaultService, editableDraft, mergeEditableDraft } from './service';
import { createProfileCache } from './profile-cache';

function record(): VaultItem {
  return {
    id: 'record', name: 'Example', type: 'login', rawType: 1, nameFailed: false,
    notes: 'searchable memo', notesFailed: false, folderId: null, favorite: false,
    reprompt: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02', deletedAt: null,
    archivedAt: null, wrappedKey: 'wrapped-item-key',
    login: { ...emptyLogin(), username: 'me', password: 'login-secret', totp: 'JBSWY3DPEHPK3PXP',
      fido2Credentials: [{ credentialId: 'credential', keyValue: 'passkey-private-material' } as never] },
    card: { cardholderName: 'Me', brand: 'Visa', number: '4111111111111111', code: '123', expMonth: '1', expYear: '2030' },
    identity: null, secureNote: null,
    sshKey: { publicKey: 'public', privateKey: 'ssh-private', fingerprint: 'fingerprint' },
    customFields: [{ name: 'PIN', value: 'hidden-field', type: 1, linkedId: null }],
    passwordHistory: [{ lastUsedDate: '2025-01-01', password: 'historical-secret' }],
    attachments: [{ id: 'a', fileName: 'document.pdf', size: '100', sizeName: '100 B', url: 'https://signed.example/token', key: 'attachment-key', failed: false }],
  };
}

function restored(items = [record()], fetchImpl: typeof fetch = async () => { throw new Error('Unexpected network'); }) {
  const client = new VaultClient({ fetchImpl });
  client.restore({
    account: { email: 'test@example.com', serverUrl: 'https://vault.example', userId: 'u', kdf: { kdf: 0, iterations: 1 } },
    syncVerified: true, userKey: makeUserKey(), token: { accessToken: 'test-access-token', refreshToken: undefined, expiresIn: 3600, key: undefined, privateKey: undefined, kdf: 0 }, items, folders: [],
  });
  return { client, service: createVaultService(client) };
}

describe('application display boundary', () => {
  it('projects custom-field presence without exposing hidden values and keeps boolean false visible', async () => {
    const item = record();
    item.customFields = [
      { name: 'Empty hidden', value: '', type: 1, linkedId: null },
      { name: 'Present hidden', value: 'private-custom-secret', type: 1, linkedId: null },
      { name: 'Boolean', value: 'false', type: 2, linkedId: null },
    ];
    const { service } = restored([item]);
    const detail = await service.getItem(item.id);
    expect(detail.customFields[0]).toMatchObject({ hasValue: false, value: null });
    expect(detail.customFields[1]).toMatchObject({ hasValue: true, value: null });
    expect(detail.customFields[2]).toMatchObject({ hasValue: true, value: 'false' });
    expect(JSON.stringify(detail)).not.toContain('private-custom-secret');
  });

  it('treats empty secrets as absent while preserving a visible decryption failure indicator', async () => {
    const item = record();
    item.login!.password = '';
    item.card!.number = '';
    item.card!.code = '';
    item.sshKey!.privateKey = '';
    item.preservation = { failures: ['字段无法解密'] } as never;
    const { service } = restored([item]);
    const detail = await service.getItem(item.id);
    expect(detail.login?.hasPassword).toBe(false);
    expect(detail.card?.hasNumber).toBe(false);
    expect(detail.card?.hasCode).toBe(false);
    expect(detail.sshKey?.hasPrivateKey).toBe(false);
    expect(detail.decryptionFailed).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('preservation');
  });

  it('lists summaries and searches notes without sending the full records', async () => {
    const { service } = restored();
    const snapshot = await service.snapshot();
    expect(snapshot.items[0]?.name).toBe('Example');
    expect(await service.search('searchable')).toHaveLength(1);
    const wire = JSON.stringify([snapshot, await service.search('')]);
    for (const secret of ['login-secret', 'historical-secret', 'hidden-field', 'passkey-private-material', 'attachment-key', 'searchable memo']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('loads detail with presence flags and retrieves one secret only on request', async () => {
    const { service } = restored();
    const detail = await service.getItem('record');
    expect(detail.login?.hasPassword).toBe(true);
    expect(detail.card?.hasNumber).toBe(true);
    expect(detail.sshKey?.hasPrivateKey).toBe(true);
    expect(detail.customFields[0]?.value).toBeNull();
    expect(detail.attachments[0]?.fileName).toBe('document.pdf');
    const wire = JSON.stringify(detail);
    for (const secret of ['login-secret', 'historical-secret', 'hidden-field', 'ssh-private', '4111111111111111', 'passkey-private-material', 'attachment-key']) expect(wire).not.toContain(secret);
    expect(await service.reveal('record', { kind: 'password' })).toBe('login-secret');
    expect(await service.reveal('record', { kind: 'custom', index: 0 })).toBe('hidden-field');
    await expect(service.reveal('record', { kind: 'history', index: -1 })).rejects.toThrow();
  });

  it('does not expose deleted/archived records in browse or direct detail requests', async () => {
    const { service } = restored([{ ...record(), deletedAt: '2026-01-03' }]);
    expect((await service.snapshot()).items).toEqual([]);
    await expect(service.getItem('record')).rejects.toThrow();
  });

  it('clears summaries and denies reads when locked', async () => {
    const { service } = restored();
    await service.lock();
    expect((await service.snapshot()).items).toEqual([]);
    expect((await service.snapshot()).status).toBe('locked');
    await expect(service.getDraft('record')).rejects.toThrow();
    await expect(service.reveal('record', { kind: 'password' })).rejects.toThrow();
  });

  it('moving one record to trash preserves the other records in the committed snapshot', async () => {
    const { service } = restored([record(), { ...record(), id: 'keep' }], async (url, init) => {
      expect(String(url)).toBe('https://vault.example/api/ciphers/record/delete');
      expect(init?.method).toBe('PUT');
      return new Response(null, { status: 204 });
    });
    await service.moveToTrash('record');
    expect((await service.snapshot()).items.map((i) => i.id)).toEqual(['keep']);
  });
});

describe('edit ownership', () => {
  it('permits editing a single record without exporting cryptographic metadata or history', () => {
    const draft = editableDraft(record());
    expect(draft.login?.password).toBe('login-secret');
    expect(draft.wrappedKey).toBeNull();
    expect(draft.login?.fido2Credentials).toEqual([]);
    expect(draft.passwordHistory).toEqual([]);
    expect(draft.attachments).toEqual([]);
  });

  it('preserves canonical metadata and allows an explicitly cleared password', () => {
    const old = record();
    const draft = editableDraft(old);
    draft.name = 'Renamed';
    draft.login!.password = null;
    draft.wrappedKey = 'malicious-replacement';
    draft.login!.fido2Credentials = [{ keyValue: 'replacement' } as never];
    const merged = mergeEditableDraft(draft, old);
    expect(merged.name).toBe('Renamed');
    expect(merged.login?.password).toBeNull();
    expect(merged.wrappedKey).toBe('wrapped-item-key');
    expect(merged.login?.fido2Credentials[0]?.keyValue).toBe('passkey-private-material');
    expect(merged.attachments[0]?.key).toBe('attachment-key');
    expect(merged.passwordHistory[0]?.password).toBe('historical-secret');
    expect(old.login?.password).toBe('login-secret');
  });

  it('rejects stale edits instead of overwriting a newer canonical record', () => {
    const draft = editableDraft(record());
    expect(() => mergeEditableDraft(draft, { ...record(), updatedAt: '2026-02-01' })).toThrow(/更新/);
  });

  it('refuses to turn decryption failures into empty fields during an edit', () => {
    const old = { ...record(), nameFailed: true, name: '' };
    const draft = editableDraft(old);
    draft.name = 'New name';
    expect(() => mergeEditableDraft(draft, old)).toThrow(/解密/);
  });
});

describe('detail resource management', () => {
  it('exposes passkey metadata without private material', async () => {
    const item = record();
    Object.assign(item.login!.fido2Credentials[0]!, { rpId: 'example.com', rpName: 'Example', userName: 'me', creationDate: '2026-01-01' });
    const { service } = restored([item]);
    const detail = await service.getItem(item.id);
    expect(detail.login?.passkeys?.[0]).toMatchObject({ credentialId: 'credential', rpId: 'example.com', userName: 'me' });
    expect(JSON.stringify(detail)).not.toContain('passkey-private-material');
  });

  it('uploads exact binary bytes and routes explicit resource removals through the current record', async () => {
    const { client, service } = restored();
    let uploaded: Uint8Array | undefined;
    const upload = vi.fn(async (_id: string, _name: string, bytes: Uint8Array) => { uploaded = bytes.slice(); });
    const removeAttachment = vi.fn(async () => {});
    const removePasskey = vi.fn(async () => {});
    const clearHistory = vi.fn(async () => {});
    Object.assign(client, { uploadAttachment: upload, deleteAttachment: removeAttachment, removePasskey, clearPasswordHistory: clearHistory });
    await service.uploadAttachment('record', 'binary.bin', 'AID/');
    expect(upload).toHaveBeenCalledWith('record', 'binary.bin', expect.any(Uint8Array));
    expect(uploaded).toEqual(Uint8Array.from([0, 128, 255]));
    expect(upload.mock.calls[0]![2].every(byte => byte === 0)).toBe(true);
    await service.deleteAttachment('record', 'a');
    await service.removePasskey('record', 'credential');
    await service.clearPasswordHistory('record');
    expect(removeAttachment).toHaveBeenCalledWith('record', 'a');
    expect(removePasskey).toHaveBeenCalledWith('record', 'credential');
    expect(clearHistory).toHaveBeenCalledWith('record');
    await service.lock();
    await expect(service.uploadAttachment('record', 'binary.bin', 'AID/')).rejects.toThrow();
    await expect(service.deleteAttachment('record', 'a')).rejects.toThrow();
    await expect(service.removePasskey('record', 'credential')).rejects.toThrow();
    await expect(service.clearPasswordHistory('record')).rejects.toThrow();
    expect(upload).toHaveBeenCalledTimes(1); expect(clearHistory).toHaveBeenCalledTimes(1);
  });

  it('masks linked passwords in detail and resolves their current value only on request', async () => {
    const item = record();
    item.customFields = [{ name: 'login_password', value: '', type: 3, linkedId: 101 }];
    const { service } = restored([item]);
    expect((await service.getItem(item.id)).customFields[0]?.value).toBeNull();
    expect(await service.reveal(item.id, { kind: 'custom', index: 0 })).toBe('login-secret');
  });
});


describe('Profile service', () => {
  const profile = { displayName: 'Lin', avatarDataUrl: null };
  it('hides marked records from browse, search, detail and reports while exposing presentation', async () => {
    const item = { ...buildProfileItem(profile), id: 'profile', updatedAt: '2026-01-01' };
    const { service } = restored([record(), item]);
    const snapshot = await service.snapshot();
    expect(snapshot.profile).toEqual(profile);
    expect(snapshot.items.map((i) => i.id)).toEqual(['record']);
    expect(await service.search('1Warden')).toEqual([]);
    await expect(service.getItem('profile')).rejects.toThrow();
    await expect(service.getDraft('profile')).rejects.toThrow();
  });
  it('creates once, updates that record, rejects stale saves and cannot save while locked', async () => {
    const { client } = restored([]);
    const service = createVaultService(client);
    const save = vi.spyOn(client, 'saveItem').mockImplementation(async (item) => {
      const result = { ...item, id: 'profile-id', updatedAt: item.updatedAt + '1' };
      client.getSession().replaceData([result], []); return result;
    });
    await service.saveProfile(profile, null);
    expect(save.mock.calls[0]?.[0].id).toBe('');
    const version = (await service.snapshot()).profileVersion;
    await service.saveProfile({ ...profile, displayName: 'New' }, version);
    expect(save.mock.calls[1]?.[0].id).toBe('profile-id');
    await expect(service.saveProfile(profile, version)).rejects.toThrow(/更新/);
    await service.lock();
    await expect(service.saveProfile(profile, null)).rejects.toThrow(/解锁/);
  });
  it('never auto-creates and refuses malformed or future records', async () => {
    const item = { ...buildProfileItem(profile), id: 'profile', notes: '{' };
    const { client, service } = restored([item]);
    const save = vi.spyOn(client, 'saveItem');
    const snapshot = await service.snapshot();
    expect(snapshot.profile).toBeNull(); expect(snapshot.profileError).toMatch(/损坏/);
    await expect(service.saveProfile(profile, snapshot.profileVersion)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not change the cached profile on a failed server write', async () => {
    const { client } = restored([]);
    const cache = { load: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const service = createVaultService(client, cache);
    vi.spyOn(client, 'saveItem').mockRejectedValue(Error('offline'));
    await expect(service.saveProfile(profile, null)).rejects.toThrow('offline');
    expect(cache.save).not.toHaveBeenCalled();
  });
  it('caches after unlock, retains display on lock and clears it on logout', async () => {
    const { client } = restored([{ ...buildProfileItem(profile), id: 'profile' }]);
    let saved: { displayName: string; avatarDataUrl: string | null } | null = null;
    const cache = { load: async () => saved, save: async (_a: unknown, p: { displayName: string; avatarDataUrl: string | null }) => { saved = p; }, clear: async () => { saved = null; } };
    const service = createVaultService(client, cache);
    expect((await service.snapshot()).profile).toEqual(profile);
    await service.lock(); expect((await service.snapshot()).profile).toEqual(profile);
    await service.logout(); expect(saved).toBeNull(); expect((await service.snapshot()).profile).toBeNull();
  });

  it.each([503, 200])('preserves presentation until an authoritative sync proves absence (HTTP %s)', async (syncStatus) => {
    const params = { serverUrl: 'https://vault.example', email: 'test@example.com', masterPassword: 'test' };
    const values = new Map<string, string>();
    const cache = createProfileCache({ get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); },
    });
    await cache.save(params, profile);
    const userKey = makeUserKey();
    const wrappedKey = await encryptBytes(concatBytes(userKey.encKey, userKey.macKey), await stretchMasterKey(
      await deriveMasterKey(params.masterPassword, params.email, { kdf: 0, iterations: 1000 })));
    let started!: () => void; let release!: () => void;
    const syncing = new Promise<void>((resolve) => { started = resolve; });
    const response = new Promise<void>((resolve) => { release = resolve; });
    const statusReads: Array<ReturnType<typeof service.snapshot>> = [];
    const client = new VaultClient({ deviceStore: { get: () => 'device', set: () => {}, clear: () => {} },
      onStatus: () => { statusReads.push(service.snapshot()); },
      fetchImpl: async (input) => {
        switch (new URL(String(input)).pathname) {
          case '/identity/accounts/prelogin': return Response.json({ kdf: 0, kdfIterations: 1000 });
          case '/identity/connect/token': return Response.json({
            access_token: `e30.${btoa(JSON.stringify({ sub: 'u' }))}.test`, expires_in: 3600, Key: wrappedKey, Kdf: 0,
          });
          case '/api/accounts/revision-date': return new Response('1');
          case '/api/sync':
            started(); await response;
            return syncStatus === 503 ? Response.json({ message: 'offline' }, { status: 503 })
              : Response.json({ profile: { id: 'u', email: params.email }, ciphers: [], folders: [], collections: [] });
          default: throw new Error('Unexpected network request');
        }
      },
    });
    const service = createVaultService(client, cache);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connecting = service.connect(params);
    await syncing;
    try {
      expect(await service.snapshot()).toMatchObject({ status: 'unlocked', profile, profileReady: false });
      await expect(service.saveProfile({ ...profile, displayName: 'New' }, null)).rejects.toThrow(/同步/);
    } finally { release(); await connecting; warning.mockRestore(); }
    await Promise.all(statusReads);
    const snapshot = await service.snapshot();
    if (syncStatus === 503) {
      expect(snapshot).toMatchObject({ profile, profileReady: false, syncing: false });
      expect(await cache.load(params)).toEqual(profile);
      await expect(service.saveProfile(profile, null)).rejects.toThrow(/同步/);
    } else {
      expect(snapshot).toMatchObject({ profile: null, profileReady: true, syncing: false });
      expect(await cache.load(params)).toBeNull();
    }
  });

  it('blocks saves while another sync is pending even for a previously verified session', async () => {
    const { client, service } = restored([]);
    client.getSession().setSyncing(true);
    expect((await service.snapshot()).profileReady).toBe(false);
    await expect(service.saveProfile(profile, null)).rejects.toThrow(/同步/);
  });
});

describe('account settings ownership', () => {
  const prefs = { mode: 'dark' as const, palette: 'github', showTypes: true };
  const device = { id: 'device-a', name: 'Windows · 桌面端', platform: 'windows' as const, client: 'desktop' as const };
  function fixture() {
    const { client, service } = restored([]);
    const save = vi.spyOn(client, 'saveItem').mockImplementation(async item => {
      const result = { ...item, id: 'account-profile', updatedAt: item.updatedAt + '1' };
      client.getSession().replaceData([result], []); return result;
    });
    return { client, service, save };
  }
  it('serializes device and preference edits to one record, preserving both', async () => {
    const { service, save } = fixture();
    await Promise.all([service.recordDevice(device), service.savePreferences(prefs, null)]);
    expect(save).toHaveBeenCalledTimes(2);
    const snapshot = await service.snapshot();
    expect(snapshot.profileSettings?.preferences).toEqual(prefs);
    expect(snapshot.profileSettings?.devices[0]).toMatchObject(device);
    expect(snapshot.items).toEqual([]);
    await service.recordDevice(device); expect(save).toHaveBeenCalledTimes(2);
    await service.lock(); expect((await service.snapshot()).profileSettings).toBeNull();
    await expect(service.recordDevice(device)).rejects.toThrow(/解锁/);
  });
  it('rejects changed preference baselines but allows unrelated profile/device changes', async () => {
    const { service } = fixture(); await service.savePreferences(prefs, null);
    await service.recordDevice(device);
    await service.savePreferences({ ...prefs, palette: 'dracula' }, prefs);
    await expect(service.savePreferences(prefs, prefs)).rejects.toThrow(/更新/);
  });
  it('does not write from queued work after lock or before verified sync', async () => {
    const { service, save, client } = fixture();
    const pending = service.recordDevice(device); await service.lock();
    await expect(pending).rejects.toThrow(/解锁/); expect(save).not.toHaveBeenCalled();
    const other = fixture(); other.client.getSession().setSyncing(true);
    await expect(other.service.savePreferences(prefs, null)).rejects.toThrow(/同步/);
    expect(other.save).not.toHaveBeenCalled();
  });
  it('keeps account settings out of the presentation profile cache', async () => {
    const item = { ...buildPreferencesItem(prefs, buildProfileItem({ displayName: 'A', avatarDataUrl: null })), id: 'p' };
    const { client } = restored([item]);
    const cache = { load: vi.fn(async () => null), save: vi.fn(async (_account: unknown, _profile: unknown) => {}), clear: vi.fn(async () => {}) };
    await createVaultService(client, cache).snapshot();
    expect(cache.save.mock.calls[0]?.[1]).toEqual({ displayName: 'A', avatarDataUrl: null });
    expect(parseProfileSettings(item).preferences).toEqual(prefs);
  });
});


describe('account switching', () => {
  it('retires keys and all old records but preserves presentation caches', async () => {
    const { client } = restored();
    const clear = vi.fn(async () => {});
    const service = createVaultService(client, { load: async () => null, save: async () => {}, clear });
    const oldKey = client.getSession().getKey()!;
    await service.switchAccount({ serverUrl: 'https://other.example', email: 'other@example.com' });
    const snapshot = await service.snapshot();
    expect(snapshot.status).toBe('locked'); expect(snapshot.account?.serverUrl).toBe('https://other.example');
    expect(snapshot.account?.email).toBe('other@example.com'); expect(snapshot.items).toEqual([]);
    expect(oldKey.encKey.every((b) => b === 0)).toBe(true); expect(clear).not.toHaveBeenCalled();
  });
  it('does not retire the current account on invalid target and supports account picker', async () => {
    const { service } = restored();
    await expect(service.switchAccount({ serverUrl: 'file:///private', email: 'other@example.com' })).rejects.toThrow();
    expect((await service.snapshot()).status).toBe('unlocked');
    await service.switchAccount(null); expect((await service.snapshot()).status).toBe('loggedOut');
  });
});

/** Real crypto/client/service chain; the HTTP boundary alone is a synthetic server. */
async function nativeBoundaryFixture() {
  const userKey = makeUserKey();
  const itemKey = makeUserKey();
  const enc = (value: string) => encryptString(value, itemKey);
  const wrappedKey = await encryptBytes(concatBytes(itemKey.encKey, itemKey.macKey), userKey);
  const dto: CipherDto = {
    id: 'native', type: 1, name: await enc('Native record'), notes: null, folderId: null,
    favorite: false, reprompt: 0, organizationId: 'organization-owner', key: wrappedKey,
    creationDate: '2026-01-01', revisionDate: '2026-01-02', deletedDate: null, archivedDate: null,
    collectionIds: ['collection-owner'],
    login: {
      username: await enc('native-user'), password: await enc('native-password'), autofillOnPageLoad: true,
      uris: [
        { uri: await enc('https://remove.test'), match: 0 },
        { uri: await enc('https://keep.test'), match: 3, futureUriData: 'uri-owner-metadata' } as never,
      ],
      fido2Credentials: [{ credentialId: 'credential-native', rpId: 'keep.test', keyValue: await enc('native-private-key'), counter: '0', discoverable: 'true', creationDate: '2026-01-01' }],
    },
    fields: [{ name: await enc('Future field'), value: await enc('future-value'), type: 44, futureFieldData: 'custom-owner-metadata' } as never],
    passwordHistory: [{ lastUsedDate: '2025-01-01', password: await enc('native-history') }],
    attachments: [{ id: 'attachment-native', fileName: await enc('file.txt'), size: '1', sizeName: '1 B', url: 'https://signed.test/private-download', key: 'attachment-owner-key' }],
  };
  Object.assign(dto, { futureTopData: 'top-owner-metadata' });
  const item = await decryptCipher(dto, userKey);
  const requests: Array<Record<string, unknown>> = [];
  const client = new VaultClient({ fetchImpl: async (url, init) => {
    if (String(url) !== 'https://vault.example/api/ciphers/native' || init?.method !== 'PUT') throw Error('Unexpected request');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    return Response.json({ ...dto, ...body, revisionDate: '2026-01-03' });
  } });
  client.restore({
    account: { email: 'test@example.com', serverUrl: 'https://vault.example', userId: 'u', kdf: { kdf: 0, iterations: 1 } },
    syncVerified: true, userKey,
    token: { accessToken: 'test-access-token', refreshToken: undefined, expiresIn: 3600, key: undefined, privateKey: undefined, kdf: 0 },
    items: [item], folders: [],
  });
  return { service: createVaultService(client), client, item, itemKey, wrappedKey, requests };
}

describe('native preservation application boundary', () => {
  it('keeps raw preservation, row identities and private resource material out of detail and snapshots', async () => {
    const { service, item } = await nativeBoundaryFixture();
    expect(item.preservation).toBeDefined();
    expect(item.login!.uris[0]!.sourceId).toBeDefined();
    const detail = await service.getItem('native');
    const wire = JSON.stringify([detail, await service.snapshot(), await service.search('Native')]);
    for (const hidden of ['preservation', 'sourceId', 'keyValue', 'native-private-key', 'native-history', 'native-password',
      'attachment-owner-key', 'private-download', 'top-owner-metadata', 'uri-owner-metadata', 'custom-owner-metadata']) {
      expect(wire).not.toContain(hidden);
    }
    expect(detail.login!.uris[1]).toEqual({ uri: 'https://keep.test', match: 3 });
    expect(detail.login!.passkeys![0]!.credentialId).toBe('credential-native');
  });

  it('exports safe row identities for editing without exporting owner-only encrypted data', async () => {
    const { service, item } = await nativeBoundaryFixture();
    const draft = await service.getDraft('native');
    expect(draft).not.toHaveProperty('preservation');
    expect(draft.wrappedKey).toBeNull();
    expect(draft.attachments).toEqual([]);
    expect(draft.passwordHistory).toEqual([]);
    expect(draft.login!.fido2Credentials).toEqual([]);
    expect(draft.login!.uris[1]!.sourceId).toBe(item.login!.uris[1]!.sourceId);
    expect(draft.customFields[0]!.sourceId).toBe(item.customFields[0]!.sourceId);
    expect(draft.customFields[0]!.unsupportedType).toBe(44);
    expect(draft.login!.autofillOnPageLoad).toBe(true);
    for (const hidden of ['top-owner-metadata', 'uri-owner-metadata', 'custom-owner-metadata', 'attachment-owner-key', 'private-download']) {
      expect(JSON.stringify(draft)).not.toContain(hidden);
    }
    draft.login!.uris[1]!.uri = 'https://edited.test';
    expect(item.login!.uris[1]!.uri).toBe('https://keep.test');
  });

  it('saves through the real client while preserving ownership and unknown row data after URL deletion', async () => {
    const { service, client, item, itemKey, wrappedKey, requests } = await nativeBoundaryFixture();
    const draft = await service.getDraft('native');
    draft.name = 'Renamed native';
    draft.login!.uris.splice(0, 1);
    draft.login!.uris[0]!.uri = 'https://edited.test';
    draft.login!.autofillOnPageLoad = false;
    draft.wrappedKey = 'forged-owner-key';
    draft.preservation = structuredClone(item.preservation!);
    draft.preservation.source.organizationId = 'forged-organization';
    draft.login!.fido2Credentials = [];
    const result = await service.saveItem(draft);
    expect(result.name).toBe('Renamed native');
    expect(requests).toHaveLength(1);
    const body = requests[0]!;
    expect(body).toMatchObject({ organizationId: 'organization-owner', collectionIds: ['collection-owner'], key: wrappedKey,
      futureTopData: 'top-owner-metadata', encryptedFor: 'u' });
    const login = body['login'] as NonNullable<CipherDto['login']>;
    expect(login.autofillOnPageLoad).toBe(false);
    expect(login.uris).toHaveLength(1);
    expect(login.uris![0]).toMatchObject({ match: 3, futureUriData: 'uri-owner-metadata' });
    expect(await decryptString(login.uris![0]!.uri!, itemKey)).toBe('https://edited.test');
    expect(body['fields']).toEqual(item.preservation!.source.fields);
    expect(login.fido2Credentials).toEqual(item.preservation!.source.login!.fido2Credentials);
    expect(client.getSession().items[0]!.login!.fido2Credentials[0]!.keyValue).toBe('native-private-key');
    expect(JSON.stringify(result)).not.toContain('preservation');
  });
});

describe('native linked field resolution', () => {
  it.each([[303, '123'], [305, '4111111111111111']] as const)('resolves card linked ID %s from the canonical card without leaking it in detail', async (linkedId, expected) => {
    const item = { ...record(), type: 'card' as const, rawType: 3, login: null };
    item.customFields = [{ name: 'Linked', value: 'stale imported value', type: 3, linkedId }];
    const { service } = restored([item]);
    expect((await service.getItem(item.id)).customFields[0]!.value).toBeNull();
    expect(await service.reveal(item.id, { kind: 'custom', index: 0 })).toBe(expected);
  });

  it('derives linked identity full names from current components and skips absent middle names', async () => {
    const item = { ...record(), type: 'identity' as const, rawType: 4, login: null,
      identity: { ...emptyIdentity(), firstName: 'Ada', middleName: null, lastName: 'Lovelace' } };
    item.customFields = [{ name: 'Full name', value: 'stale imported name', type: 3, linkedId: 418 }];
    const { service } = restored([item]);
    expect(await service.reveal(item.id, { kind: 'custom', index: 0 })).toBe('Ada Lovelace');
  });

  it('rejects a linked target belonging to a different item type', async () => {
    const item = record();
    item.customFields = [{ name: 'Invalid target', value: 'must not be returned', type: 3, linkedId: 305 }];
    const { service } = restored([item]);
    await expect(service.reveal(item.id, { kind: 'custom', index: 0 })).rejects.toThrow(/关联字段/);
  });
});
