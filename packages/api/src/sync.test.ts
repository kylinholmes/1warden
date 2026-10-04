import { describe, it, expect, vi } from 'vitest';
import { HttpClient } from './http';
import { sync, partitionCiphers, getRevisionDate } from './sync';
import type { CipherDto } from './types';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function respond(body: unknown, status = 200): FetchMock {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
}

function cipher(over: Partial<CipherDto>): CipherDto {
  return {
    id: 'c1', type: 1, name: '2.aa|bb|cc', notes: null, folderId: null,
    favorite: false, reprompt: 0, organizationId: null, key: null,
    creationDate: '2026-01-01T00:00:00.000000Z',
    revisionDate: '2026-01-01T00:00:00.000000Z',
    deletedDate: null, archivedDate: null, edit: true, viewPassword: true,
    ...over,
  };
}

describe('sync', () => {
  it('requests sync with excludeDomains and returns the parsed result', async () => {
    const fetchImpl = respond({
      profile: { id: 'u1' }, folders: [], ciphers: [], collections: [], object: 'sync',
    });
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    const r = await sync(http, 't');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://x.test/api/sync?excludeDomains=true');
    expect(r.ciphers).toEqual([]);
  });

  it('defaults missing arrays to empty rather than undefined', async () => {
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: respond({ profile: {} }) });
    const r = await sync(http, 't');
    expect(r.folders).toEqual([]);
    expect(r.ciphers).toEqual([]);
    expect(r.collections).toEqual([]);
  });

  // 容错：服务端加字段不该影响我们
  it('ignores unknown top-level fields', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      fetchImpl: respond({ profile: {}, ciphers: [], brandNewSection: { x: 1 } }),
    });
    expect((await sync(http, 't')).ciphers).toEqual([]);
  });

  it('propagates an auth error', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test', fetchImpl: respond({ message: 'Invalid claim' }, 401),
    });
    await expect(sync(http, 'bad')).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('partitionCiphers', () => {
  it('splits active / archived / trashed', () => {
    const { active, archived, trashed } = partitionCiphers([
      cipher({ id: 'live' }),
      cipher({ id: 'arch', archivedDate: '2026-02-01T00:00:00.000000Z' }),
      cipher({ id: 'gone', deletedDate: '2026-03-01T00:00:00.000000Z' }),
    ]);
    expect(active.map((c) => c.id)).toEqual(['live']);
    expect(archived.map((c) => c.id)).toEqual(['arch']);
    expect(trashed.map((c) => c.id)).toEqual(['gone']);
  });

  // 服务端不做过滤，所以「已删除的条目仍出现在 sync 响应里」是正常现象。
  // 不分区的话，用户删掉的密码会一直出现在列表和搜索结果里。
  it('treats an item that is both archived and trashed as trashed', () => {
    const both = cipher({
      id: 'both',
      archivedDate: '2026-02-01T00:00:00.000000Z',
      deletedDate: '2026-03-01T00:00:00.000000Z',
    });
    const { active, archived, trashed } = partitionCiphers([both]);
    expect(active).toEqual([]);
    expect(archived).toEqual([]);
    expect(trashed.map((c) => c.id)).toEqual(['both']);
  });

  // 畸形日期一律按「未删除/未归档」处理，也就是**照常显示**。
  // 反过来（判为已删除）会把条目藏起来 —— 用户看不到自己的密码是被卡住，
  // 而多看到一个条目只是烦。失败要可见，不要隐藏。
  it('treats a malformed date as absent, so the item stays visible', () => {
    const { active, archived, trashed } = partitionCiphers([
      cipher({ id: 'empty', deletedDate: '' }),
      cipher({ id: 'garbage', archivedDate: 'not-a-date' as unknown as string }),
    ]);
    // 空串与垃圾值都「不构成一个有效的日期」
    expect(trashed.map((c) => c.id)).toEqual([]);
    expect(archived.map((c) => c.id)).toEqual([]);
    expect(active.map((c) => c.id)).toEqual(['empty', 'garbage']);
  });

  it('accepts a real ISO date as present', () => {
    const { trashed } = partitionCiphers([cipher({ id: 'x', deletedDate: '2026-03-01T00:00:00.000000Z' })]);
    expect(trashed.map((c) => c.id)).toEqual(['x']);
  });

  it('handles an empty list', () => {
    expect(partitionCiphers([])).toEqual({ active: [], archived: [], trashed: [] });
  });

  it('preserves input order within each partition', () => {
    const { active } = partitionCiphers([
      cipher({ id: 'a' }), cipher({ id: 'b', deletedDate: '2026-01-01T00:00:00.000000Z' }),
      cipher({ id: 'c' }), cipher({ id: 'd' }),
    ]);
    expect(active.map((c) => c.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('getRevisionDate', () => {
  // 服务器返回的是**裸 JSON 整数**，不是对象
  it('parses the bare integer epoch-millis response', async () => {
    const fetchImpl = vi.fn(async () => new Response('1759500000000', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await getRevisionDate(http, 't')).toBe(1759500000000);
  });

  it('throws malformedResponse for a non-numeric body', async () => {
    const fetchImpl = vi.fn(async () => new Response('"nope"', { status: 200 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    await expect(getRevisionDate(http, 't')).rejects.toMatchObject({ kind: 'malformedResponse' });
  });

  it('accepts a numeric string too (some proxies re-serialize)', async () => {
    const fetchImpl = vi.fn(async () => new Response('"1759500000000"', { status: 200 }));
    const http = new HttpClient({ baseUrl: 'https://x.test', fetchImpl });
    expect(await getRevisionDate(http, 't')).toBe(1759500000000);
  });
});
