import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { VaultClient } from './client';
import { encryptCipher } from './encrypt';
import { buildProfileItem } from './profile';
import { emptyLogin, type VaultItem } from './model';

const item = (id: string, over: Partial<VaultItem> = {}): VaultItem => ({ id, name: `Record ${id}`,
  nameFailed: false, notes: null, notesFailed: false, type: 'login', rawType: 1, folderId: null, favorite: false,
  reprompt: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', deletedAt: null, archivedAt: null,
  wrappedKey: null, login: emptyLogin(), card: null, identity: null, secureNote: null, sshKey: null,
  customFields: [], passwordHistory: [], attachments: [], ...over });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(records = [item('active'), item('archive', { archivedAt: '2026-10-03T00:00:00Z' }), item('trash', { deletedAt: '2026-10-04T00:00:00Z' })]) {
  const key = makeUserKey(); const rows = new Map<string, CipherDto>();
  async function put(record: VaultItem, over: Partial<CipherDto> = {}) {
    rows.set(record.id, { ...await encryptCipher(record, key, {}), id: record.id, creationDate: record.createdAt,
      revisionDate: record.updatedAt, deletedDate: record.deletedAt, archivedDate: record.archivedAt, key: null, ...over } as CipherDto);
  }
  for (const record of records) await put(record);
  const writes: string[] = []; let hook: ((path: string, method: string) => Promise<Response | void>) | undefined;
  const client = new VaultClient({ fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname; const method = init?.method ?? 'GET';
    const custom = await hook?.(path, method); if (custom) return custom;
    if (path === '/api/sync') return Response.json({ ciphers: [...rows.values()], folders: [], profile: {}, collections: [] });
    const match = /^\/api\/ciphers\/([^/]+)(\/delete)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!); const record = rows.get(id);
      if (!record) return Response.json({}, { status: 404 });
      if (method === 'GET') return Response.json(record);
      writes.push(`${method} ${path}`);
      if (method === 'DELETE') rows.delete(id);
      else if (method === 'PUT' && match[2]) record.deletedDate = '2026-10-14T00:00:00Z';
      else throw new Error(`Unexpected write ${method} ${path}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  } });
  const account = { serverUrl: 'https://vault.test', email: 'bulk@example.invalid', userId: 'user', kdf: { kdf: 0 as const, iterations: 1 } };
  client.restore({ account, userKey: key, token: { accessToken: 'token' } as never, items: [], folders: [] });
  return { client, key, account, rows, writes, put, setHook(value: typeof hook) { hook = value; } };
}
afterEach(() => vi.restoreAllMocks());

describe('confirmed personal bulk deletion', () => {
  it('previews authoritative personal records including archives while excluding profile, organization and trash', async () => {
    const f = await fixture();
    await f.put({ ...buildProfileItem({ displayName: 'Profile', avatarDataUrl: null }), id: 'profile' });
    await f.put(item('organization'), { organizationId: 'org' });
    const preview = await f.client.previewBulkDelete('vault');
    expect(preview).toMatchObject({ count: 2, scope: 'vault', account: { email: 'bulk@example.invalid', serverUrl: 'https://vault.test' } });
    expect(preview.token.length).toBeGreaterThan(20);
    expect(f.writes).toEqual([]);
    expect(await f.client.commitBulkDelete(preview.token)).toEqual({ completed: 2, skipped: 0, failed: [] });
    expect(f.writes).toEqual(['PUT /api/ciphers/active/delete', 'PUT /api/ciphers/archive/delete']);
    expect(f.rows.get('profile')?.deletedDate).toBeNull();
    expect(f.rows.get('organization')?.deletedDate).toBeNull();
  });

  it('permanently deletes only previewed trash and skips restored records and new arrivals', async () => {
    const f = await fixture([item('a', { deletedAt: '2026-10-04T00:00:00Z' }), item('b', { deletedAt: '2026-10-04T00:00:00Z' }), item('live')]);
    const preview = await f.client.previewBulkDelete('trash');
    f.rows.get('b')!.deletedDate = null;
    await f.put(item('new-trash', { deletedAt: '2026-10-05T00:00:00Z' }));
    expect(await f.client.commitBulkDelete(preview.token)).toEqual({ completed: 1, skipped: 1, failed: [] });
    expect(f.writes).toEqual(['DELETE /api/ciphers/a']);
    expect([...f.rows.keys()]).toEqual(['b', 'live', 'new-trash']);
  });

  it('rechecks each record after prior deletes and protects newly assigned organization/profile records', async () => {
    const f = await fixture([item('a'), item('b'), item('c')]);
    const preview = await f.client.previewBulkDelete('vault');
    f.setHook(async (path, method) => { if (path === '/api/ciphers/a/delete' && method === 'PUT') {
      f.rows.get('b')!.organizationId = 'org';
      await f.put({ ...buildProfileItem({ displayName: 'Profile', avatarDataUrl: null }), id: 'c' });
    } });
    expect(await f.client.commitBulkDelete(preview.token)).toEqual({ completed: 1, skipped: 2, failed: [] });
    expect(f.writes).toEqual(['PUT /api/ciphers/a/delete']);
  });

  it('fails safe when a secure note might contain an unreadable internal profile marker', async () => {
    const f = await fixture();
    await f.put({ ...buildProfileItem({ displayName: 'Profile', avatarDataUrl: null }), id: 'broken-profile' });
    f.rows.get('broken-profile')!.fields![0]!.name = '2.invalid';
    await expect(f.client.previewBulkDelete('vault')).rejects.toThrow(/个人资料|无法.*确认/);
    expect(f.writes).toEqual([]);
  });

  it('returns named partial failures without retrying an ambiguous delete and consumes confirmation once', async () => {
    const f = await fixture([item('a'), item('b')]);
    const preview = await f.client.previewBulkDelete('vault');
    let attempts = 0;
    f.setHook(async (path, method) => { if (path === '/api/ciphers/a/delete' && method === 'PUT') {
      attempts++; f.rows.get('a')!.deletedDate = '2026-10-14T00:00:00Z'; return new Response(null, { status: 503 });
    } });
    const result = await f.client.commitBulkDelete(preview.token);
    expect(result).toMatchObject({ completed: 1, skipped: 0, failed: [{ name: 'Record a', reason: expect.stringMatching(/未能确认|同步/) }] });
    expect(attempts).toBe(1);
    await expect(f.client.commitBulkDelete(preview.token)).rejects.toThrow(/过期|执行|失效/);
    expect((await f.client.previewBulkDelete('vault')).count).toBe(0);
  });

  it('expires confirmation before a write and prevents concurrent token reuse', async () => {
    const f = await fixture();
    const preview = await f.client.previewBulkDelete('vault');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    await expect(f.client.commitBulkDelete(preview.token)).rejects.toThrow(/过期|失效/);
    expect(f.writes).toEqual([]);
    vi.restoreAllMocks();
    const next = await f.client.previewBulkDelete('vault');
    const results = await Promise.allSettled([f.client.commitBulkDelete(next.token), f.client.commitBulkDelete(next.token)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.writes).toHaveLength(2);
  });

  it('checks expiry after an awaited read before sending irreversible deletion', async () => {
    const f = await fixture(); const preview = await f.client.previewBulkDelete('trash');
    const future = Date.now() + 11 * 60_000;
    f.setHook(async (path, method) => { if (path === '/api/ciphers/trash' && method === 'GET') vi.spyOn(Date, 'now').mockReturnValue(future); });
    await expect(f.client.commitBulkDelete(preview.token)).rejects.toThrow(/过期|失效/);
    expect(f.writes).toEqual([]);
  });

  it('cancels after a lock during a deletion and never sends the next write', async () => {
    const f = await fixture([item('a'), item('b')]); const preview = await f.client.previewBulkDelete('vault');
    const started = deferred(); const release = deferred();
    f.setHook(async (path, method) => { if (path.endsWith('/a/delete') && method === 'PUT') { started.resolve(); await release.promise; } });
    const pending = f.client.commitBulkDelete(preview.token); await started.promise; f.client.lock(); release.resolve();
    await expect(pending).rejects.toThrow(/锁定|取消/);
    expect(f.writes).toEqual(['PUT /api/ciphers/a/delete']);
    expect(f.rows.get('b')!.deletedDate).toBeNull();
  });

  it('rejects pending previews when account ownership changes and ignores a late sync result', async () => {
    const f = await fixture(); const started = deferred(); const release = deferred();
    f.setHook(async path => { if (path === '/api/sync') { started.resolve(); await release.promise; } });
    const pending = f.client.previewBulkDelete('vault'); await started.promise;
    f.client.restore({ account: { ...f.account, email: 'other@example.invalid' }, userKey: makeUserKey(), token: { accessToken: 'other' } as never, items: [], folders: [] });
    release.resolve(); await expect(pending).rejects.toThrow(/锁定|取消|变更/);
    expect(f.writes).toEqual([]);
  });

  it('waits for an existing item write then rechecks its latest membership before deletion', async () => {
    const f = await fixture([item('a')]); const preview = await f.client.previewBulkDelete('vault');
    const started = deferred(); const release = deferred(); let deletes = 0;
    f.setHook(async (path, method) => { if (path.endsWith('/a/delete') && method === 'PUT') { deletes++; started.resolve(); await release.promise; } });
    const ordinary = f.client.moveToTrash('a'); await started.promise;
    const bulk = f.client.commitBulkDelete(preview.token); release.resolve(); await ordinary;
    expect(await bulk).toEqual({ completed: 0, skipped: 1, failed: [] });
    expect(deletes).toBe(1);
  });

  it('binds preview to the selected account even when switching retains the unlocked vault session', async () => {
    const f = await fixture(); let selection = 0;
    const preview = await f.client.previewBulkDelete('vault', () => { if (selection !== 0) throw new Error('账户已切换'); });
    selection++;
    await expect(f.client.commitBulkDelete(preview.token)).rejects.toThrow(/切换/);
    expect(f.writes).toEqual([]);
  });

  it('awaits external account guards between writes and stops a batch when selection changes', async () => {
    const f = await fixture([item('a'), item('b')]); let selected = true;
    const preview = await f.client.previewBulkDelete('vault');
    f.setHook(async (path, method) => { if (path.endsWith('/a/delete') && method === 'PUT') selected = false; });
    await expect(f.client.commitBulkDelete(preview.token, async () => {
      await Promise.resolve(); if (!selected) throw new Error('账户已切换');
    })).rejects.toThrow(/切换/);
    expect(f.writes).toEqual(['PUT /api/ciphers/a/delete']);
    expect(f.client.isUnlocked()).toBe(true);
  });

  it('does not resume after an owner guard throws once and later succeeds', async () => {
    const f = await fixture([item('a'), item('b')]); let cancel = false;
    const preview = await f.client.previewBulkDelete('vault');
    f.setHook(async (path, method) => { if (path.endsWith('/a/delete') && method === 'PUT') cancel = true; });
    await expect(f.client.commitBulkDelete(preview.token, () => {
      if (cancel) { cancel = false; throw new Error('账户已取消'); }
    })).rejects.toThrow(/取消/);
    expect(f.writes).toEqual(['PUT /api/ciphers/a/delete']);
  });

  it.each(['garbage', 42, 0, false, {}, '2026-10-04', '2026-10-04Tnot-a-date'])('excludes malformed deletion marker %j from both cleanup scopes', async deletedDate => {
    const f = await fixture([item('uncertain')]);
    Object.assign(f.rows.get('uncertain')!, { deletedDate });
    for (const scope of ['vault', 'trash'] as const) {
      const preview = await f.client.previewBulkDelete(scope);
      expect(preview.count).toBe(0);
      expect(await f.client.commitBulkDelete(preview.token)).toEqual({ completed: 0, skipped: 0, failed: [] });
    }
    expect(f.writes).toEqual([]);
    expect(f.rows.has('uncertain')).toBe(true);
  });

  it.each(['before-commit', 'before-delete'])('skips a trash record whose deletion marker becomes malformed %s', async phase => {
    const f = await fixture([item('trash', { deletedAt: '2026-10-04T00:00:00Z' })]);
    const preview = await f.client.previewBulkDelete('trash');
    expect(preview.count).toBe(1);
    if (phase === 'before-commit') f.rows.get('trash')!.deletedDate = 'garbage';
    else f.setHook(async (path, method) => {
      if (path === '/api/ciphers/trash' && method === 'GET') f.rows.get('trash')!.deletedDate = 'garbage';
    });
    expect(await f.client.commitBulkDelete(preview.token)).toEqual({ completed: 0, skipped: 1, failed: [] });
    expect(f.writes).toEqual([]);
    expect(f.rows.has('trash')).toBe(true);
  });
});
