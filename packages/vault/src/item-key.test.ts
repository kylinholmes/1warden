import { describe, it, expect } from 'vitest';
import {
  deriveMasterKey, stretchMasterKey, makeUserKey, encryptString, encryptBytes, decryptString,
  KDF_TYPE_PBKDF2, type SymmetricKey, type KdfConfig,
} from '@1warden/crypto';
import { VaultClient } from './client';
import { createFakeServer, fakeJwt, type FakeCipher } from './testing/fake-server';

const EMAIL = 'onewarden-test@example.com';
const PASSWORD = 'Test-Master-Password-123!';
const KDF: KdfConfig = { kdf: KDF_TYPE_PBKDF2, iterations: 1000 };
const USER_ID = 'user-0000-1111-2222-333333333333';

function memoryDeviceStore() {
  let id: string | null = null;
  return { get: () => id, set: (v: string) => { id = v; }, clear: () => { id = null; } };
}

/** 把一把 64 字节的条目密钥包装成 EncString（**按字节**，见 attachments.ts 的说明） */
async function wrapItemKey(itemKey: SymmetricKey, userKey: SymmetricKey): Promise<string> {
  return encryptBytes(new Uint8Array([...itemKey.encKey, ...itemKey.macKey]), userKey);
}

/**
 * ⚠️ **这是一条数据损坏的回归测试。**
 *
 * 带独立密钥的条目（`key` 字段非空，组织共享的条目几乎都是）保存时，
 * 字段必须用**条目密钥**加密 —— 而服务端那个 `key` 字段声明着「这条用独立密钥」。
 *
 * `saveItem` 此前从来不看 `itemKey`，永远用用户密钥重新加密：
 *
 *   const body = await encryptCipher(item, key, opts);   // key 永远是用户密钥
 *
 * 于是字段被用户密钥加密、`key` 却还声明着独立密钥 —— 任何客户端
 * （包括我们自己）按声明去解都会失败，**这条条目就废了**。
 * 而且它不会报错：保存成功、同步成功，用户下次打开才发现里面是空的。
 *
 * 根因是会话里没有留着**包装后的条目密钥**（只有一个是/否的标记），
 * 所以保存时根本拿不到它。附件那条限制也是同一个根因。
 */
describe('带独立密钥的条目', () => {
  async function setup() {
    const userKey = makeUserKey();
    const itemKey = makeUserKey();
    const wrapped = await wrapItemKey(itemKey, userKey);

    // 服务端上这条条目的**所有字段都是用条目密钥加密的**
    const cipher: FakeCipher = {
      id: 'c-item-key',
      type: 1,
      name: await encryptString('共享条目', itemKey),
      notes: null,
      folderId: null,
      favorite: false,
      reprompt: 0,
      organizationId: 'org-1',
      key: wrapped,
      creationDate: '2026-01-01T00:00:00.000000Z',
      revisionDate: '2026-01-01T00:00:00.000000Z',
      deletedDate: null,
      archivedDate: null,
      login: {
        username: await encryptString('me', itemKey),
        password: await encryptString('pw', itemKey),
        totp: null,
        passwordRevisionDate: null,
        uris: [],
      },
      fields: [], passwordHistory: [],
    };

    const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF);
    const stretchedMasterKey = await stretchMasterKey(masterKey);

    /** 客户端 PUT 上来的请求体 —— 断言就落在这上面 */
    let saved: Record<string, unknown> | null = null;

    const server = createFakeServer({
      userKey, stretchedMasterKey, kdfIterations: 1000,
      override: (path, init) => {
        if (path === '/api/sync') {
          return Response.json({
            profile: { id: USER_ID, email: EMAIL },
            folders: [], ciphers: [cipher], collections: [],
          });
        }
        if (init?.method === 'PUT' && path.startsWith('/api/ciphers/')) {
          saved = JSON.parse(String(init.body)) as Record<string, unknown>;
          // 回一个和存进去一致的 DTO，让 saveItem 能走完
          return Response.json({ ...cipher, ...saved, id: cipher.id });
        }
        return undefined;
      },
    });

    const client = new VaultClient({ fetchImpl: server.fetchImpl, deviceStore: memoryDeviceStore() });
    await client.connect({ serverUrl: 'https://vault.test', email: EMAIL, masterPassword: PASSWORD });

    return {
      client, userKey, itemKey,
      saved: () => saved,
      item: () => client.getSession().items[0]!,
    };
  }

  it('reads the wrapped item key into the session', async () => {
    const { item, client } = await setup();
    // 会话里必须留着**包装后的**那把密钥 —— 只有一个布尔标记的话，
    // 保存和取附件时都拿不到它
    expect(item().wrappedKey).not.toBeNull();
    expect(client.getSession().isUnlocked()).toBe(true);
    expect(item().name).toBe('共享条目');
  });

  it('★ re-encrypts with the item key, not the user key', async () => {
    const { client, item, itemKey, saved } = await setup();

    await client.saveItem({ ...item(), name: '改过名字的共享条目' });

    const body = saved();
    expect(body).not.toBeNull();

    // ⚠️ 用**条目密钥**必须能解开。解不开就说明被用户密钥加密了 ——
    // 而服务端那个 key 字段还声明着独立密钥，这条条目从此谁也读不了
    await expect(decryptString(String(body!['name']), itemKey)).resolves.toBe('改过名字的共享条目');
  });

  it('does not fall back to the user key when re-saving', async () => {
    const { client, item, userKey, saved } = await setup();
    await client.saveItem({ ...item(), name: '改过名字的共享条目' });

    // 反面：用用户密钥**不该**解得开 —— 解开了恰恰说明加密用错了密钥
    await expect(decryptString(String(saved()!['name']), userKey)).rejects.toThrow();
  });

  it('keeps the wrapped key on the item after saving', async () => {
    const { client, item } = await setup();
    const before = item().wrappedKey;
    const after = await client.saveItem({ ...item(), name: 'X' });
    // 保存不该把「这条有独立密钥」这件事弄丢 —— 丢了下次同步就解不开
    expect(after.wrappedKey).toBe(before);
  });

  it('treats an item with no key as using the user key', async () => {
    const { client, item, userKey } = await setup();
    const plain = { ...item(), wrappedKey: null };
    expect(() => client.saveItem(plain)).not.toThrow();
    void userKey;
  });
});
