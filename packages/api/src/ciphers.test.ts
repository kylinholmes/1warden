import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import {
  createCipher, updateCipher, softDeleteCipher, hardDeleteCipher,
  restoreCipher, setArchived, moveCiphers, updateCipherPartial,
} from './ciphers';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function respond(body: unknown = {}, status = 200): FetchMock {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }

function calls(f: FetchMock): Call[] {
  return f.mock.calls.map((c) => {
    const init = (c[1] ?? {}) as RequestInit;
    return {
      url: String(c[0]),
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>,
    };
  });
}

function one(f: FetchMock): Call {
  return calls(f)[0]!;
}

const base = {
  type: 1, name: '2.aa|bb|cc', notes: null, folderId: null,
  organizationId: null, favorite: false, reprompt: 0,
};

describe('createCipher', () => {
  it('POSTs to /api/ciphers with encryptedFor set to the given user id', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'user-uuid', base);
    const c = one(fetchImpl);
    expect(c.url).toBe('https://x.test/api/ciphers');
    expect(c.method).toBe('POST');
    // encryptedFor 缺失导致的是**反序列化失败**（不是校验错误），必须总是发送
    expect(c.body!['encryptedFor']).toBe('user-uuid');
  });

  it('sends folderId explicitly even when null', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'u', base);
    expect('folderId' in one(fetchImpl).body!).toBe(true);
    expect(one(fetchImpl).body!['folderId']).toBeNull();
  });

  it('omits optional keys the caller did not set', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'u', base);
    for (const k of ['login', 'card', 'identity', 'secureNote', 'fields', 'passwordHistory', 'key', 'archivedDate']) {
      expect(k in one(fetchImpl).body!, `${k} 不该出现`).toBe(false);
    }
  });

  it('passes through a provided type-specific payload', async () => {
    const fetchImpl = respond({ id: 'new' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await createCipher(http, 'u', { ...base, login: { username: '2.a|b|c' } });
    expect(one(fetchImpl).body!['login']).toEqual({ username: '2.a|b|c' });
  });
});

describe('updateCipher', () => {
  it('PUTs to /api/ciphers/{id}', async () => {
    const fetchImpl = respond({ id: 'c1' });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', base);
    expect(one(fetchImpl).url).toBe('https://x.test/api/ciphers/c1');
    expect(one(fetchImpl).method).toBe('PUT');
  });

  // ⚠️ 省略 folderId 会静默把条目移出文件夹 —— 全量更新必须显式发送
  it('always includes folderId so a full update cannot silently unfolder an item', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', { ...base, folderId: 'f1' });
    expect(one(fetchImpl).body!['folderId']).toBe('f1');
  });

  // ⚠️ archivedDate 语义是反的：null = 取消归档。全量更新不能无脑带上它。
  it('omits archivedDate unless the caller sets it explicitly', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', base);
    expect('archivedDate' in one(fetchImpl).body!).toBe(false);
  });

  it('passes lastKnownRevisionDate through when supplied (optimistic concurrency)', async () => {
    const fetchImpl = respond({});
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await updateCipher(http, 'c1', 'u', { ...base, lastKnownRevisionDate: '2026-01-01T00:00:00.000000Z' });
    expect(one(fetchImpl).body!['lastKnownRevisionDate']).toBe('2026-01-01T00:00:00.000000Z');
  });
});

// ⚠️⚠️ 整个计划里最重要的一组测试。
// 动词写反 = 用户**永久丢失数据且无法恢复**。
describe('delete verbs (soft vs hard — inverted from intuition)', () => {
  it('softDeleteCipher uses PUT /delete — this is the RECOVERABLE path', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await softDeleteCipher(http, 'c1');
    const c = one(fetchImpl);
    expect(c.method).toBe('PUT');
    expect(c.url).toBe('https://x.test/api/ciphers/c1/delete');
  });

  it('hardDeleteCipher uses DELETE /{id} — this is PERMANENT', async () => {
    const fetchImpl = respond();
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await hardDeleteCipher(http, 'c1');
    const c = one(fetchImpl);
    expect(c.method).toBe('DELETE');
    expect(c.url).toBe('https://x.test/api/ciphers/c1');
  });

  // 若两者用了同一个动词，这条会立刻失败
  it('the two delete paths never collide', async () => {
    const f1 = respond(), f2 = respond();
    await softDeleteCipher(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f1 }), 'c1');
    await hardDeleteCipher(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f2 }), 'c1');
    expect(one(f1).method).not.toBe(one(f2).method);
    expect(one(f1).url).not.toBe(one(f2).url);
  });

  // 硬删除绝不能走 POST /delete —— 虽然那也是一种硬删除，
  // 但两者语义不同，混用会让「哪个是哪个」再也说不清
  it('hardDeleteCipher never targets a /delete path', async () => {
    const fetchImpl = respond();
    await hardDeleteCipher(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'c1');
    expect(one(fetchImpl).url).not.toContain('/delete');
  });
});

describe('restoreCipher', () => {
  it('PUTs to /restore', async () => {
    const fetchImpl = respond();
    await restoreCipher(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'c1');
    expect(one(fetchImpl)).toMatchObject({ method: 'PUT', url: 'https://x.test/api/ciphers/c1/restore' });
  });
});

describe('setArchived', () => {
  it('PUTs to /archive when archiving', async () => {
    const fetchImpl = respond();
    await setArchived(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'c1', true);
    expect(one(fetchImpl).url).toBe('https://x.test/api/ciphers/c1/archive');
  });

  it('PUTs to /unarchive when unarchiving', async () => {
    const fetchImpl = respond();
    await setArchived(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'c1', false);
    expect(one(fetchImpl).url).toBe('https://x.test/api/ciphers/c1/unarchive');
  });
});

describe('moveCiphers', () => {
  it('POSTs {folderId, ids} to /ciphers/move', async () => {
    const fetchImpl = respond();
    await moveCiphers(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'f1', ['c1', 'c2']);
    const c = one(fetchImpl);
    expect(c.url).toBe('https://x.test/api/ciphers/move');
    expect(c.body).toEqual({ folderId: 'f1', ids: ['c1', 'c2'] });
  });

  it('accepts null to move items out of any folder', async () => {
    const fetchImpl = respond();
    await moveCiphers(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), null, ['c1']);
    expect(one(fetchImpl).body!['folderId']).toBeNull();
  });

  it('does not send a request for an empty id list', async () => {
    const fetchImpl = respond();
    await moveCiphers(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'f1', []);
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });
});

describe('updateCipherPartial', () => {
  it('PUTs {folderId, favorite} — the only path that works on read-only ciphers', async () => {
    const fetchImpl = respond();
    await updateCipherPartial(new HttpClient({ baseUrl: 'https://x.test', fetchImpl }), 'c1', { folderId: null, favorite: true });
    const c = one(fetchImpl);
    expect(c.url).toBe('https://x.test/api/ciphers/c1/partial');
    expect(c.body!['favorite']).toBe(true);
  });

  it('always sends current folder membership, including explicit null for unfiled records', async () => {
    const f1 = respond();
    await updateCipherPartial(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f1 }), 'c1', { folderId: null, favorite: false });
    expect(one(f1).body!['folderId']).toBeNull();

    const f2 = respond();
    await updateCipherPartial(new HttpClient({ baseUrl: 'https://x.test', fetchImpl: f2 }), 'c1', { folderId: 'f9', favorite: false });
    expect(one(f2).body!['folderId']).toBe('f9');
  });
});

it('retains unknown writable cipher data but pins encryptedFor to the authenticated user', async () => {
  const fetchImpl = respond({ id: 'c1' });
  const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
  await updateCipher(http, 'c1', 'authenticated-user', {
    ...base, organizationId: 'org1', collectionIds: ['collection1'],
    future: { encrypted: 'opaque' }, encryptedFor: 'untrusted-user',
  });
  expect(one(fetchImpl).body).toMatchObject({
    organizationId: 'org1', collectionIds: ['collection1'],
    future: { encrypted: 'opaque' }, encryptedFor: 'authenticated-user',
  });
});
