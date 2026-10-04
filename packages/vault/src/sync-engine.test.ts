import { describe, it, expect, vi } from 'vitest';
import { makeUserKey } from '@coffer/crypto';
import { SyncEngine } from './sync-engine';
import type { SyncDeps } from './sync-engine';
import { VaultSession } from './session';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function session(): VaultSession {
  const s = new VaultSession();
  s.setAccount({ serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1 } });
  s.beginUnlock();
  s.beginUnlock();
  s.completeUnlock(makeUserKey());
  return s;
}

function item(id: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: id, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: emptyLogin(), card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const PROFILE = { id: 'u1', email: 'a@b.com', name: null, key: null, privateKey: null };

/** 假的 api 依赖 —— 只测编排逻辑（短路、去重、降级） */
function deps(over: Partial<SyncDeps> = {}): SyncDeps {
  return {
    getRevisionDate: vi.fn(async () => 100),
    sync: vi.fn(async () => ({ profile: PROFILE, folders: [], ciphers: [], collections: [] })),
    decryptCipher: vi.fn(async (dto) => item(dto.id)),
    decryptFolder: vi.fn(async (dto) => ({ id: dto.id, name: dto.id, nameFailed: false, updatedAt: 'x' })),
    ...over,
  } as SyncDeps;
  // 注意 `partitionCiphers` **不**注入 —— 它是纯函数，直接 import，
  // 这样测试跑的是真实的集成而不是一个仿制品
}

const K = makeUserKey();

describe('SyncEngine — revision-date 短路', () => {
  it('performs a full sync the first time', async () => {
    const d = deps();
    expect((await new SyncEngine({ deps: d, session: session() }).sync({ unlockedKey: K })).skipped).toBe(false);
    expect(d.sync).toHaveBeenCalledTimes(1);
  });

  // 最大的性能杠杆：服务端没变就完全不发 sync 请求
  it('skips entirely when the revision date has not advanced', async () => {
    const d = deps();
    const e = new SyncEngine({ deps: d, session: session() });
    await e.sync({ unlockedKey: K });
    expect((await e.sync({ unlockedKey: K })).skipped).toBe(true);
    expect(d.sync).toHaveBeenCalledTimes(1);
  });

  it('syncs again once the revision advances', async () => {
    let rev = 100;
    const d = deps({ getRevisionDate: vi.fn(async () => rev) });
    const e = new SyncEngine({ deps: d, session: session() });
    await e.sync({ unlockedKey: K });
    rev = 200;
    expect((await e.sync({ unlockedKey: K })).skipped).toBe(false);
  });

  it('force bypasses the short-circuit', async () => {
    const d = deps();
    const e = new SyncEngine({ deps: d, session: session() });
    await e.sync({ unlockedKey: K });
    expect((await e.sync({ unlockedKey: K, force: true })).skipped).toBe(false);
  });

  // 失败的同步不能推进 lastRevision —— 否则数据永远补不回来
  it('does not advance lastSyncedAt when the sync fails', async () => {
    const d = deps({ sync: vi.fn(async () => { throw Object.assign(new Error('x'), { kind: 'server' }); }) });
    const e = new SyncEngine({ deps: d, session: session() });
    await expect(e.sync({ unlockedKey: K })).rejects.toThrow();
    expect(e.lastSyncedAt).toBeNull();
  });
});

describe('SyncEngine — 并发去重', () => {
  it('coalesces concurrent calls into one request', async () => {
    // gate 必须在调用 sync 之前就建好 —— 否则 release 还是那个空函数，
    // Promise 永远不 settle，测试会超时
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({
      sync: vi.fn(async () => {
        await gate;
        return { profile: PROFILE, folders: [], ciphers: [], collections: [] };
      }),
    });
    const e = new SyncEngine({ deps: d, session: session() });

    const a = e.sync({ unlockedKey: K });
    const b = e.sync({ unlockedKey: K });
    release();
    await Promise.all([a, b]);

    expect(d.sync).toHaveBeenCalledTimes(1);
  });

  it('allows a new sync after the previous settles', async () => {
    const d = deps();
    const e = new SyncEngine({ deps: d, session: session() });
    await e.sync({ unlockedKey: K });
    await e.sync({ unlockedKey: K, force: true });
    expect(d.sync).toHaveBeenCalledTimes(2);
  });
});

describe('SyncEngine — 只把活跃条目写进会话', () => {
  // ⚠️ 服务端会返回已删除和已归档的条目，不在写进 session 前分区的话，
  // 用户删掉的密码会出现在列表和搜索里
  it('filters trashed and archived items out of the session', async () => {
    const d = deps({
      sync: vi.fn(async () => ({
        profile: PROFILE, folders: [], collections: [],
        ciphers: [
          { id: 'live', deletedDate: null, archivedDate: null },
          { id: 'arch', deletedDate: null, archivedDate: '2026-02-01T00:00:00.000000Z' },
          { id: 'gone', deletedDate: '2026-03-01T00:00:00.000000Z', archivedDate: null },
        ] as never,
      })),
    });
    const s = session();
    await new SyncEngine({ deps: d, session: s }).sync({ unlockedKey: K });
    expect(s.items.map((i) => i.id)).toEqual(['live']);
  });
});

describe('SyncEngine — 单条失败不拖垮整体', () => {
  it('keeps syncing when one item fails to decrypt', async () => {
    const d = deps({
      sync: vi.fn(async () => ({
        profile: PROFILE, folders: [], collections: [],
        ciphers: [{ id: 'good', deletedDate: null, archivedDate: null },
          { id: 'bad', deletedDate: null, archivedDate: null }] as never,
      })),
      decryptCipher: vi.fn(async (dto) => {
        if (dto.id === 'bad') throw new Error('boom');
        return item(dto.id);
      }),
    });
    const onError = vi.fn();
    const s = session();
    const out = await new SyncEngine({ deps: d, session: s, onError }).sync({ unlockedKey: K });

    expect(out.failedCount).toBe(1);
    expect(out.itemCount).toBe(1);
    expect(s.items.map((i) => i.id)).toEqual(['good']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not write into a session that got locked mid-sync', async () => {
    const d = deps({
      sync: vi.fn(async () => ({
        profile: PROFILE, folders: [], collections: [],
        ciphers: [{ id: 'x', deletedDate: null, archivedDate: null }] as never,
      })),
    });
    const s = session();
    const p = new SyncEngine({ deps: d, session: s }).sync({ unlockedKey: K });
    s.lock(); // 用户在同步过程中锁定
    await p;
    expect(s.items).toEqual([]);
  });
});
