import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { listFolders, createFolder, updateFolder, deleteFolder } from './folders';
import { getProfile, verifyPassword } from './accounts';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function respond(body: unknown = {}, status = 200): FetchMock {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function one(f: FetchMock) {
  const init = (f.mock.calls[0]![1] ?? {}) as RequestInit;
  return {
    url: String(f.mock.calls[0]![0]),
    method: String(init.method),
    body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
  };
}

describe('folders', () => {
  it('unwraps the list envelope', async () => {
    const f = respond({
      data: [{ id: 'f1', name: '2.a|b|c', revisionDate: '2026-01-01T00:00:00.000000Z' }],
      object: 'list', continuationToken: null,
    });
    expect(await listFolders(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f })))
      .toEqual([{ id: 'f1', name: '2.a|b|c', revisionDate: '2026-01-01T00:00:00.000000Z' }]);
  });

  it('returns an empty array when data is missing', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({}) });
    expect(await listFolders(http)).toEqual([]);
  });

  it('creates a folder with the encrypted name', async () => {
    const f = respond({ id: 'new' });
    await createFolder(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f }), '2.a|b|c');
    expect(one(f)).toMatchObject({ url: 'https://x.test/api/folders', method: 'POST' });
    expect(one(f).body).toEqual({ name: '2.a|b|c' });
  });

  it('updates via PUT /api/folders/{id}', async () => {
    const f = respond({ id: 'f1' });
    await updateFolder(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f }), 'f1', '2.x|y|z');
    expect(one(f)).toMatchObject({ url: 'https://x.test/api/folders/f1', method: 'PUT' });
  });

  it('deletes via DELETE /api/folders/{id}', async () => {
    const f = respond();
    await deleteFolder(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f }), 'f1');
    expect(one(f)).toMatchObject({ url: 'https://x.test/api/folders/f1', method: 'DELETE' });
  });

  // ⚠️ Vaultwarden 没有批量删除端点（DELETE /api/folders 会 404），
  // 所以这里根本不该有 bulkDeleteFolders 这种 API —— 有就是撒谎
  it('exposes no bulk-delete helper (Vaultwarden does not implement one)', async () => {
    const mod = await import('./folders');
    expect(Object.keys(mod).filter((k) => /bulk|all/i.test(k))).toEqual([]);
  });
});

describe('accounts', () => {
  it('getProfile GETs /api/accounts/profile', async () => {
    const f = respond({ id: 'u1', email: 'a@b.com', key: '2.a|b|c', privateKey: '2.d|e|f' });
    const p = await getProfile(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f }));
    expect(one(f).url).toBe('https://x.test/api/accounts/profile');
    expect(p.id).toBe('u1');
  });

  it('verifyPassword POSTs the hash', async () => {
    const f = respond({ object: 'masterPasswordPolicy' });
    await verifyPassword(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f }), 'HASH');
    expect(one(f)).toMatchObject({ url: 'https://x.test/api/accounts/verify-password', method: 'POST' });
    expect(one(f).body).toEqual({ masterPasswordHash: 'HASH' });
  });

  it('propagates an auth error for a wrong password', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl: respond({ message: 'Invalid password' }, 400),
    });
    await expect(verifyPassword(http, 'bad')).rejects.toMatchObject({ kind: 'auth' });
  });
});
