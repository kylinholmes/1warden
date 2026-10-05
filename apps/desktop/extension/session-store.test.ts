import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStore, restrictSessionToTrustedContexts, type StorageArea } from './session-store';
import { makeUserKey, toBase64 } from '@coffer/crypto';
import type { VaultItem } from '@coffer/vault';

/** 内存版存储区，行为对齐 chrome.storage.session */
function memoryArea(): StorageArea & { dump(): Record<string, unknown> } {
  let data: Record<string, unknown> = {};
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) { data = { ...data, ...items }; },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k];
    },
    async clear() { data = {}; },
    dump: () => ({ ...data }),
  };
}

function item(id: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username: 'u', password: 'p', totp: null, uris: [{ uri: 'https://a.test', match: null }], passwordRevisionDate: null, fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const account = { serverUrl: 'https://vault.test', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0 as const, iterations: 1000 } };

let area: ReturnType<typeof memoryArea>;
let store: SessionStore;

beforeEach(() => {
  area = memoryArea();
  store = new SessionStore(area);
});

describe('SessionStore —— 往返', () => {
  it('returns null when nothing is stored', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips the account, the key and the items', async () => {
    const key = makeUserKey();
    await store.save({ account, userKey: key, items: [item('1'), item('2')], folders: [], token: null });

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.account).toEqual(account);
    expect(loaded!.items.map((i) => i.id)).toEqual(['1', '2']);
  });

  /**
   * 密钥是 `Uint8Array`，存进 storage 必然经过序列化。
   * 只要有一个字节对不上，保险库就整个解不开 —— 而且报错会是一句
   * 看不出所以然的「解密失败」。所以逐字节比对。
   */
  it('preserves the key byte for byte through storage', async () => {
    const key = makeUserKey();
    await store.save({ account, userKey: key, items: [], folders: [], token: null });

    const loaded = await store.load();
    expect(Array.from(loaded!.userKey.encKey)).toEqual(Array.from(key.encKey));
    expect(Array.from(loaded!.userKey.macKey)).toEqual(Array.from(key.macKey));
  });

  it('preserves key bytes that include 0x00 and 0xFF', async () => {
    const encKey = new Uint8Array(32);
    encKey[0] = 0; encKey[1] = 255; encKey[31] = 0;
    const macKey = new Uint8Array(32).fill(255);
    await store.save({ account, userKey: { encKey, macKey }, items: [], folders: [], token: null });

    const loaded = await store.load();
    expect(loaded!.userKey.encKey[0]).toBe(0);
    expect(loaded!.userKey.encKey[1]).toBe(255);
    expect(loaded!.userKey.macKey.every((b) => b === 255)).toBe(true);
  });

  it('overwrites a previous session rather than merging', async () => {
    await store.save({ account, userKey: makeUserKey(), items: [item('old')], folders: [], token: null });
    await store.save({ account, userKey: makeUserKey(), items: [item('new')], folders: [], token: null });
    expect((await store.load())!.items.map((i) => i.id)).toEqual(['new']);
  });
});

describe('SessionStore —— 清理', () => {
  it('clear removes everything', async () => {
    await store.save({ account, userKey: makeUserKey(), items: [item('1')], folders: [], token: null });
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(Object.keys(area.dump())).toEqual([]);
  });

  it('locking leaves no key material behind', async () => {
    const key = makeUserKey();
    await store.save({ account, userKey: key, items: [item('1')], folders: [], token: null });
    await store.clear();

    // 存储区里不该再出现密钥的任何一段
    const raw = JSON.stringify(area.dump());
    expect(raw).not.toContain(toBase64(key.encKey));
    expect(raw).not.toContain(toBase64(key.macKey));
  });
});

describe('SessionStore —— 损坏的数据不能把扩展卡死', () => {
  /**
   * storage 里的东西可能是上一个版本的扩展写的，也可能被别处改坏。
   * 这种情况要当作「没登录」，让用户重新解锁 —— 而不是抛异常。
   * service worker 里抛未捕获异常会让整个后台失效。
   */
  // ⚠️ 每条用例**只留一个缺陷**，其余字段都填成合法的。
  // 否则 revive 会因为别的原因先返回 null，测试通过得毫无意义 ——
  // 这个坑是变异检验抓出来的：删掉密钥长度校验后测试照样绿。
  it('treats a record missing the key as no session', async () => {
    await area.set({ 'coffer.session': { account, items: [], folders: [] } });
    expect(await store.load()).toBeNull();
  });

  it('treats a record with a malformed key as no session', async () => {
    await area.set({
      'coffer.session': {
        account, userKey: { encKey: 'not base64!!', macKey: 'x' }, items: [], folders: [],
      },
    });
    expect(await store.load()).toBeNull();
  });

  it('treats a non-object record as no session', async () => {
    await area.set({ 'coffer.session': 'garbage' });
    expect(await store.load()).toBeNull();
  });

  it('treats a key of the wrong length as no session', async () => {
    await area.set({
      'coffer.session': {
        account,
        userKey: {
          encKey: toBase64(new Uint8Array([1, 2, 3])),
          macKey: toBase64(new Uint8Array([1])),
        },
        items: [], folders: [],
      },
    });
    expect(await store.load()).toBeNull();
  });

  it('treats a record missing the account as no session', async () => {
    await area.set({
      'coffer.session': {
        userKey: { encKey: 'AA==', macKey: 'AA==' }, items: [], folders: [],
      },
    });
    expect(await store.load()).toBeNull();
  });

  it('treats a record whose items are not an array as no session', async () => {
    await area.set({
      'coffer.session': {
        account, userKey: { encKey: 'AA==', macKey: 'AA==' }, items: 'nope', folders: [],
      },
    });
    expect(await store.load()).toBeNull();
  });

  it('does not throw when the storage area itself fails', async () => {
    const broken: StorageArea = {
      get: async () => { throw new Error('storage 坏了'); },
      set: async () => { throw new Error('storage 坏了'); },
      remove: async () => { throw new Error('storage 坏了'); },
      clear: async () => { throw new Error('storage 坏了'); },
    };
    const s = new SessionStore(broken);
    await expect(s.load()).resolves.toBeNull();
    await expect(s.clear()).resolves.toBeUndefined();
  });
});

describe('SessionStore —— 只写内存区', () => {
  /**
   * 这条是硬不变量（spec S1）：明文与密钥**永不落盘**。
   * `chrome.storage.local` 会写到磁盘，`storage.session` 只在内存里 ——
   * 用错一个 API 就足以让「不落盘」这句话变成假的。
   */
  it('writes only through the area it was given', async () => {
    const setSpy = vi.spyOn(area, 'set');
    await store.save({ account, userKey: makeUserKey(), items: [], folders: [], token: null });

    expect(setSpy).toHaveBeenCalled();
    // 扩展不该碰全局的 chrome.storage —— 拿不到就说明只用了注入的那一份
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
  });
});

describe('restrictSessionToTrustedContexts —— 会话区的访问级别', () => {
  it('Chrome：把访问级别显式声明为仅受信任上下文', () => {
    const setAccessLevel = vi.fn(async () => {});
    restrictSessionToTrustedContexts({ setAccessLevel });

    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('以会话区自身为 this 调用', () => {
    const area = {
      calls: 0,
      setAccessLevel(this: { calls: number }) { this.calls += 1; return Promise.resolve(); },
    };
    restrictSessionToTrustedContexts(area);

    expect(area.calls).toBe(1);
  });

  /**
   * ⚠️ 回归测试 —— 这条对应 Zen 里那次真实的崩溃。
   *
   * Firefox（以及基于它的 Zen）**没有** `setAccessLevel`：它把这条限制做进了
   * schema（`storage.session` 的 allowedContexts 里没有 `content`），是结构性的、
   * 不可调宽的，因此压根不需要这个 API。
   *
   * 原先的写法是 `ext.storage.session.setAccessLevel({...}).catch(() => {})`，
   * 想用 `.catch()` 兜住「老 Chrome 没有」。但属性不存在时抛的是**同步** TypeError ——
   * 求值到那一行整个 background 就断了，`.catch()` 根本没机会被构造出来。
   *
   * 所以必须是**能力检测**，不是异常处理。
   */
  it('Firefox：没有这个 API 时不能抛', () => {
    expect(() => restrictSessionToTrustedContexts({})).not.toThrow();
  });

  it('同步抛出的实现也不能把 background 带崩', () => {
    expect(() => restrictSessionToTrustedContexts({
      setAccessLevel: () => { throw new TypeError('Illegal invocation'); },
    })).not.toThrow();
  });

  it('返回被拒绝的 Promise 时不产生未处理的拒绝', async () => {
    restrictSessionToTrustedContexts({
      setAccessLevel: async () => { throw new Error('无权设置访问级别'); },
    });
    // 未处理的拒绝会让 vitest 直接判这条失败
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
