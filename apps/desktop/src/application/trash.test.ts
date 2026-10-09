import { describe, expect, it, vi } from 'vitest';
import { encryptCipher, buildProfileItem, VaultClient, emptyLogin, type VaultItem } from '@1warden/vault';
import { makeUserKey } from '@1warden/crypto';
import { createVaultService } from './service';

async function fixture() {
  const key = makeUserKey();
  const draft: VaultItem = { id: 'deleted', name: 'Deleted login', nameFailed: false, type: 'login', rawType: 1,
    login: { ...emptyLogin(), username: 'test-user', password: 'must-stay-private' }, card: null, identity: null,
    secureNote: null, sshKey: null, customFields: [], attachments: [], passwordHistory: [],
    notes: 'private note', notesFailed: false, favorite: false, folderId: null, reprompt: 0, wrappedKey: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', deletedAt: null, archivedAt: null };
  const profile = { ...buildProfileItem({ displayName: 'Profile', avatarDataUrl: null }), id: 'protected' };
  const encoded = await Promise.all([draft, { ...draft, id: 'active' }, profile].map(async item => ({
    ...await encryptCipher(item, key, {}), id: item.id, deletedDate: item.id === 'active' ? null : '2026-10-08T00:00:00Z',
    creationDate: draft.createdAt, revisionDate: draft.updatedAt,
  })));
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let restoreStatus = 204;
  let failSync = false;
  let afterSync: (() => void) | undefined;
  let afterRestore: (() => void) | undefined;
  const client = new VaultClient({ fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body });
    if (path === '/api/accounts/revision-date') return Response.json(42);
    if (path === '/api/sync') {
      afterSync?.();
      return failSync ? Response.json({}, { status: 503 }) : Response.json({ ciphers: encoded, folders: [], profile: {}, collections: [] });
    }
    if (path === '/api/ciphers/deleted/restore') {
      if (restoreStatus === 204) encoded[0]!.deletedDate = null;
      afterRestore?.();
      return new Response(null, { status: restoreStatus });
    }
    throw new Error(`Unexpected request ${path}`);
  } });
  client.restore({ account: { email: 'trash@example.com', serverUrl: 'https://vault.test', userId: 'user', kdf: { kdf: 0, iterations: 1 } },
    userKey: key, token: { accessToken: 'token' } as never, syncVerified: true, items: [{ ...draft, id: 'active' }], folders: [] });
  return { client, service: createVaultService(client), requests,
    setRestoreStatus(value: number) { restoreStatus = value; }, setAfterSync(value: () => void) { afterSync = value; },
    setAfterRestore(value: () => void) { afterRestore = value; },
    denyEdit() { Object.assign(encoded[0]!, { edit: false }); },
    addBroken() { encoded.push({ ...encoded[0]!, id: 'unreadable', key: '2.invalid' }); },
    setFailSync(value: boolean) { failSync = value; } };
}

describe('trash display and restore boundary', () => {
  it('shows a safe unreadable placeholder without preventing normal records from being restored', async () => {
    const { service, addBroken } = await fixture();
    addBroken();
    const trash = await service.listTrash();
    expect(trash.map(item => item.id)).toEqual(['deleted', 'unreadable']);
    expect(trash[0]?.restoreError).toBeNull();
    expect(trash[1]).toMatchObject({ name: '', nameFailed: true, restoreError: expect.stringMatching(/无法读取/) });
    const wire = JSON.stringify(trash);
    expect(wire).not.toContain('2.invalid');
    expect(wire).not.toContain('must-stay-private');
    expect(wire).not.toContain('private note');
    await expect(service.restoreItem('deleted')).resolves.toBeUndefined();
    expect((await service.snapshot()).items.map(item => item.id).sort()).toEqual(['active', 'deleted']);
    expect((await service.listTrash()).map(item => item.id)).toEqual(['unreadable']);
  });

  it('rejects unreadable restoration before any write without disclosing raw crypto errors', async () => {
    const { service, addBroken, requests } = await fixture();
    addBroken();
    await expect(service.restoreItem('unreadable')).rejects.toThrow(/无法读取/);
    expect(requests.some(request => request.path.endsWith('/restore'))).toBe(false);
  });

  it('lists only ordinary deleted summaries without secrets or profile records', async () => {
    const { service } = await fixture();
    const trash = await service.listTrash();
    expect(trash.map(item => item.id)).toEqual(['deleted']);
    expect(JSON.stringify(trash)).not.toContain('must-stay-private');
    expect(JSON.stringify(trash)).not.toContain('private note');
    expect((await service.snapshot()).items.map(item => item.id)).toEqual(['active']);
    await expect(service.getDraft('deleted')).rejects.toThrow();
    await expect(service.reveal('deleted', { kind: 'password' })).rejects.toThrow();
  });

  it('uses the native restore endpoint without rewriting encrypted metadata, then refreshes active records', async () => {
    const { service, requests } = await fixture();
    await service.restoreItem('deleted');
    expect(requests.find(request => request.path.endsWith('/restore'))).toEqual({
      path: '/api/ciphers/deleted/restore', method: 'PUT', body: undefined,
    });
    expect((await service.snapshot()).items.map(item => item.id).sort()).toEqual(['active', 'deleted']);
    expect(await service.listTrash()).toEqual([]);
  });

  it('rejects active, unknown and protected record IDs before any restoration mutation', async () => {
    const { service, requests } = await fixture();
    for (const id of ['active', 'missing', 'protected']) await expect(service.restoreItem(id)).rejects.toThrow();
    expect(requests.some(request => request.path.endsWith('/restore'))).toBe(false);
  });

  it('leaves the original state intact when the server denies restoration', async () => {
    const { service, setRestoreStatus } = await fixture();
    setRestoreStatus(403);
    await expect(service.restoreItem('deleted')).rejects.toThrow();
    expect((await service.snapshot()).items.map(item => item.id)).toEqual(['active']);
  });

  it('rejects read-only records before sending a restore request', async () => {
    const { service, denyEdit, requests } = await fixture();
    denyEdit();
    await expect(service.restoreItem('deleted')).rejects.toThrow(/权限/);
    expect(requests.some(request => request.path.endsWith('/restore'))).toBe(false);
  });

  it('keeps a committed restore visible and reports only sync failure if the subsequent refresh goes offline', async () => {
    const { service, setAfterRestore, setFailSync } = await fixture();
    setAfterRestore(() => setFailSync(true));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await expect(service.restoreItem('deleted')).resolves.toBeUndefined(); }
    finally { warning.mockRestore(); }
    const snapshot = await service.snapshot();
    expect(snapshot.items.map(item => item.id).sort()).toEqual(['active', 'deleted']);
    expect(snapshot.syncError).toMatch(/同步失败/);
  });

  it('cancels a trash read or restore after locking instead of publishing another account data', async () => {
    const { client, service, setAfterSync, requests } = await fixture();
    setAfterSync(() => client.lock());
    await expect(service.restoreItem('deleted')).rejects.toThrow(/锁定|变更/);
    expect(requests.some(request => request.path.endsWith('/restore'))).toBe(false);
    expect((await service.snapshot()).items).toEqual([]);
  });
});
