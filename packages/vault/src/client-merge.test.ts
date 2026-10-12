import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { encryptBytes, makeUserKey } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { VaultClient } from './client';
import { encryptCipher } from './encrypt';
import { decryptCipher } from './decrypt';
import { emptyLogin, type VaultItem } from './model';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
function item(id: string): VaultItem {
  return { id, type: 'login', rawType: 1, name: 'Fixture Login', nameFailed: false, notes: null, notesFailed: false,
    folderId: null, favorite: false, reprompt: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username: 'fixture-user', password: 'fixture-password', uris: [{ uri: 'https://fixture.invalid', match: null }] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

/** Real loopback HTTP + production transport, crypto, preservation and service.
 * Only server state is a deterministic in-memory Vaultwarden-contract fixture. */
async function fixture(options: { itemKey?: boolean; sources?: number; conflicts?: boolean } = {}) {
  const userKey = makeUserKey(); const recordKey = options.itemKey ? makeUserKey() : userKey;
  const initial = Array.from({ length: (options.sources ?? 1) + 1 }, (_, index) => item(index === 0 ? 'base' : `source${index}`));
  if (options.itemKey) initial[0]!.wrappedKey = await encryptBytes(new Uint8Array([...recordKey.encKey, ...recordKey.macKey]), userKey);
  initial[1]!.notes = 'private source note';
  if (options.conflicts) {
    initial[0]!.login!.totp = 'fixture-base-seed'; initial[1]!.login!.totp = 'fixture-source-seed';
    initial[1]!.login!.password = 'fixture-source-password';
  }
  initial[1]!.customFields = [{ name: 'Recovery', value: 'private recovery value', type: 1, linkedId: null }];
  initial[1]!.passwordHistory = Array.from({ length: 7 }, (_, i) => ({ password: `history-secret-${i}`, lastUsedDate: `2025-01-0${i + 1}T00:00:00Z` }));
  const records = new Map<string, CipherDto>();
  for (const [index, value] of initial.entries()) records.set(value.id, { ...await encryptCipher(value, userKey, { itemKey: index === 0 ? recordKey : userKey }),
    id: value.id, creationDate: value.createdAt, revisionDate: value.updatedAt } as CipherDto);
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let failSave = false; const failDelete = new Set<string>(); let corruptSave = false; let revision = 0;
  let onRequest: ((method: string, path: string) => Promise<void>) | null = null;
  let afterSave: (() => void) | null = null;
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url!; const method = request.method!;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : null;
    requests.push({ method, path, body });
    if (onRequest) await onRequest(method, path);
    const id = path.split('/')[3]!; const record = records.get(id);
    const send = (status: number, data?: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(data === undefined ? '' : JSON.stringify(data)); };
    if (request.headers.authorization !== 'Bearer fixture-token') return send(401, {});
    if (!record) return send(404, {});
    if (method === 'GET') return send(200, record);
    if (method === 'PUT' && path.endsWith('/delete')) {
      if (failDelete.has(id)) return send(503, {});
      records.set(id, { ...record, deletedDate: '2026-02-01T00:00:00Z' }); return send(204);
    }
    if (method === 'PUT' && path.endsWith('/partial')) {
      records.set(id, { ...record, folderId: body!.folderId as string | null, favorite: body!.favorite as boolean }); return send(204);
    }
    if (method === 'PUT') {
      if (failSave) return send(503, {});
      if (body!.lastKnownRevisionDate !== record.revisionDate) return send(409, {});
      expect(body!.encryptedFor).toBe('fixture-user-id');
      const { encryptedFor: _owner, lastKnownRevisionDate: _revision, ...content } = body!;
      const next = { ...content, id, creationDate: record.creationDate, revisionDate: `2026-02-01T00:00:0${++revision}Z`,
        ...(corruptSave ? { notes: null } : {}) } as unknown as CipherDto;
      records.set(id, next); afterSave?.(); return send(200, next);
    }
    send(405, {});
  };
  const server = createServer((request, response) => { void handler(request, response).catch(() => { response.writeHead(500); response.end('{}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (typeof address !== 'object' || !address) throw Error('Fixture listener unavailable');
  const client = new VaultClient({ fetchImpl: fetch });
  const restore = async () => client.restore({ account: { serverUrl: `http://127.0.0.1:${address.port}`, email: 'fixture@example.invalid', userId: 'fixture-user-id', kdf: { kdf: 0, iterations: 1 } },
    userKey: { encKey: userKey.encKey.slice(), macKey: userKey.macKey.slice() }, token: { accessToken: 'fixture-token' } as never,
    items: await Promise.all([...records.values()].map(dto => decryptCipher(dto, userKey))), folders: [], syncVerified: true });
  await restore();
  cleanup.push(async () => { client.lock(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { client, records, requests, userKey, restore,
    failSave: () => { failSave = true; }, failDelete: (id: string) => failDelete.add(id), corruptSave: () => { corruptSave = true; },
    onRequest: (callback: typeof onRequest) => { onRequest = callback; }, afterSave: (callback: () => void) => { afterSave = callback; },
    preview: () => client.previewMerge({ baseId: 'base', sourceIds: initial.slice(1).map(value => value.id) }),
  };
}

describe('organization merge over the encrypted HTTP boundary', () => {
  it('reveals exactly one explicit conflict field and rejects foreign, stale or consumed preview requests', async () => {
    const f = await fixture({ conflicts: true }); const preview = await f.preview();
    expect(JSON.stringify(preview)).not.toContain('fixture-source-password'); expect(JSON.stringify(preview)).not.toContain('fixture-base-seed');
    await expect(f.client.revealMergeValue({ token: preview.token, fieldKey: 'password', itemId: 'source1' })).resolves.toBe('fixture-source-password');
    await expect(f.client.revealMergeValue({ token: preview.token, fieldKey: 'totp', itemId: 'base' })).resolves.toBe('fixture-base-seed');
    await expect(f.client.revealMergeValue({ token: preview.token, fieldKey: 'password', itemId: 'stranger' })).rejects.toThrow(/不属于/);
    await expect(f.client.revealMergeValue({ token: preview.token, fieldKey: 'notes', itemId: 'base' } as never)).rejects.toThrow(/无效/);
    f.records.set('source1', { ...f.records.get('source1')!, favorite: true });
    await expect(f.client.revealMergeValue({ token: preview.token, fieldKey: 'password', itemId: 'source1' })).rejects.toThrow(/已变化/);
    const next = await f.preview();
    const result = await f.client.mergeItems({ token: next.token, choices: { password: 'source1', totp: 'base' } });
    expect(result.trashedIds).toEqual(['source1']);
    const saved = await decryptCipher(f.records.get('base')!, f.userKey);
    expect(saved.passwordHistory).toHaveLength(8); expect(saved.passwordHistory.some(row => row.password === 'fixture-password')).toBe(true);
    expect(saved.customFields.some(row => row.value === 'fixture-source-seed' && row.type === 1)).toBe(true);
    await expect(f.client.revealMergeValue({ token: next.token, fieldKey: 'password', itemId: 'base' })).rejects.toThrow(/已执行/);
  });

  it('cancels an explicit conflict reveal if locking interrupts the server read', async () => {
    const f = await fixture({ conflicts: true }); const preview = await f.preview();
    const entered = deferred(); const release = deferred();
    f.onRequest(async (method, path) => { if (method === 'GET' && path.endsWith('/source1')) { entered.resolve(); await release.promise; } });
    const reading = f.client.revealMergeValue({ token: preview.token, fieldKey: 'password', itemId: 'source1' });
    const rejected = expect(reading).rejects.toThrow(/锁定|账户/);
    await entered.promise; f.client.lock(); release.resolve(); await rejected;
  });

  it('preserves the base key, all history and source content before reversible delete', async () => {
    const f = await fixture({ itemKey: true }); const oldKey = f.records.get('base')!.key;
    const originalSource = structuredClone(f.records.get('source1')!);
    const preview = await f.preview(); expect(preview.blockers).toEqual([]); expect(preview.fields).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain('private');
    const result = await f.client.mergeItems({ token: preview.token, choices: {} });
    expect(result).toEqual({ baseId: 'base', saved: true, trashedIds: ['source1'], retainedSources: [] });
    const saved = await decryptCipher(f.records.get('base')!, f.userKey);
    expect(saved.wrappedKey).toBe(oldKey); expect(saved.notes).toBe('private source note');
    expect(saved.customFields[0]!.value).toBe('private recovery value'); expect(saved.passwordHistory).toHaveLength(7);
    expect(saved.login!.password).toBe('fixture-password'); expect(saved.preservation!.failures).toEqual([]);
    const writes = f.requests.filter(request => request.method === 'PUT');
    expect(writes.map(request => request.path)).toEqual(['/api/ciphers/base', '/api/ciphers/source1/delete']);
    expect(JSON.stringify(writes[0]!.body)).not.toContain('private recovery value');
    expect(f.records.get('source1')!.deletedDate).toBeTruthy();
    expect(f.records.get('source1')).toEqual({ ...originalSource, deletedDate: '2026-02-01T00:00:00Z' });
  });

  it('requires new preview when remote source revision or content changed, without any write', async () => {
    const f = await fixture(); const preview = await f.preview();
    f.records.set('source1', { ...f.records.get('source1')!, favorite: true });
    await expect(f.client.mergeItems({ token: preview.token, choices: {} })).rejects.toThrow(/已变化/);
    expect(f.requests.filter(request => request.method !== 'GET')).toEqual([]);
  });

  it('does not touch sources after base save failure and consumes the token', async () => {
    const f = await fixture(); const preview = await f.preview(); f.failSave();
    await expect(f.client.mergeItems({ token: preview.token, choices: {} })).rejects.toThrow(/未处理任何来源/);
    await expect(f.client.mergeItems({ token: preview.token, choices: {} })).rejects.toThrow(/已过期或已执行/);
    expect(f.requests.filter(request => request.path.endsWith('/delete'))).toEqual([]);
  });

  it('returns partial trash results without repeating the merge on retry', async () => {
    const f = await fixture({ sources: 2 }); const preview = await f.preview(); f.failDelete('source1');
    const result = await f.client.mergeItems({ token: preview.token, choices: {} });
    expect(result.trashedIds).toEqual(['source2']); expect(result.retainedSources).toEqual([{ id: 'source1', reason: expect.stringMatching(/未能确认/) }]);
    await expect(f.client.mergeItems({ token: preview.token, choices: {} })).rejects.toThrow(/已执行/);
    expect(f.requests.filter(request => request.method === 'PUT' && request.path === '/api/ciphers/base')).toHaveLength(1);
  });

  it('retains a source changed after the base save instead of trashing newer data', async () => {
    const f = await fixture(); const preview = await f.preview();
    f.afterSave(() => f.records.set('source1', { ...f.records.get('source1')!, favorite: true }));
    const result = await f.client.mergeItems({ token: preview.token, choices: {} });
    expect(result.retainedSources[0]!.reason).toMatch(/发生变化/); expect(result.trashedIds).toEqual([]);
    expect(f.requests.filter(request => request.path.endsWith('/delete'))).toEqual([]);
  });

  it('retains all sources if the server drops merged content from the saved record', async () => {
    const f = await fixture(); const preview = await f.preview(); f.corruptSave();
    const result = await f.client.mergeItems({ token: preview.token, choices: {} });
    expect(result.retainedSources[0]!.reason).toMatch(/核验未通过/); expect(result.trashedIds).toEqual([]);
  });

  it('serializes writes to every participant and rejects a stale plan after a queued source edit', async () => {
    const f = await fixture(); const preview = await f.preview(); const entered = deferred(); const release = deferred();
    f.onRequest(async (_method, path) => { if (path.endsWith('/partial')) { entered.resolve(); await release.promise; } });
    const toggling = f.client.toggleFavorite('source1'); await entered.promise;
    const merging = f.client.mergeItems({ token: preview.token, choices: {} });
    const rejected = expect(merging).rejects.toThrow(/已变化/); release.resolve(); await toggling; await rejected;
    expect(f.requests.filter(request => request.path === '/api/ciphers/base' && request.method === 'PUT')).toEqual([]);
  });

  it('rejects cross-session tokens and prevents writes if locking interrupts revalidation', async () => {
    const f = await fixture(); let preview = await f.preview(); f.client.lock(); await f.restore();
    await expect(f.client.mergeItems({ token: preview.token, choices: {} })).rejects.toThrow(/已过期/);
    preview = await f.preview(); const entered = deferred(); const release = deferred();
    f.onRequest(async (method, path) => { if (method === 'GET' && path.endsWith('/base')) { entered.resolve(); await release.promise; } });
    const merging = f.client.mergeItems({ token: preview.token, choices: {} }); const rejected = expect(merging).rejects.toThrow(/锁定|账户/);
    await entered.promise; f.client.lock(); release.resolve(); await rejected;
    expect(f.requests.filter(request => request.method === 'PUT')).toEqual([]);
  });

  it('rejects unrelated, duplicated or oversized selections at the owner boundary', async () => {
    const f = await fixture();
    await expect(f.client.previewMerge({ baseId: 'base', sourceIds: ['base'] })).rejects.toThrow(/重复/);
    await expect(f.client.previewMerge({ baseId: 'base', sourceIds: Array(50).fill('source1') })).rejects.toThrow(/50/);
    await expect(f.client.previewMerge({ baseId: 'base', sourceIds: ['missing'] })).rejects.toThrow();
    f.client.getSession().replaceData(f.client.getSession().items.map(value => value.id === 'source1'
      ? { ...value, login: { ...value.login!, username: 'unrelated-user' } } : value), []);
    await expect(f.preview()).rejects.toThrow(/不属于同一重复组/);
    expect(f.requests).toEqual([]);
  });
});
