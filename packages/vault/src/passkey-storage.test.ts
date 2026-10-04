import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey, encryptString } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherDto, CipherFido2CredentialDto } from '@coffer/api';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { emptyLogin, type VaultItem } from './model';
import type { StoredPasskey } from './passkey';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

const PASSKEY: StoredPasskey = {
  credentialId: 'aBcD1234',
  keyType: 'public-key',
  keyAlgorithm: 'ECDSA',
  keyCurve: 'P-256',
  keyValue: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg',
  rpId: 'github.com',
  rpName: 'GitHub',
  userHandle: 'dXNlcg',
  userName: 'kylin@example.com',
  counter: '7',
  discoverable: 'true',
  creationDate: '2026-01-01T00:00:00.000000Z',
};

function loginItem(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'c1', type: 'login', rawType: 1, name: 'GitHub', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00.000000Z', updatedAt: '2026-01-01T00:00:00.000000Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), fido2Credentials: [PASSKEY] },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

describe('passkey 的线上形态', () => {
  /**
   * ⚠️ 只有 `keyValue` 加密。
   * 整条一起加密的话，官方 Bitwarden 客户端读不出来 —— 用户换回去就丢 passkey；
   * 而一个都不加密的话，私钥就明文躺在服务器上。
   */
  it('encrypts keyValue and leaves the metadata plaintext', async () => {
    const body = await encryptCipher(loginItem(), key, {});
    const cred = body.login?.fido2Credentials?.[0];
    expect(cred).toBeDefined();

    expect(cred!.keyValue).toMatch(/^2\./);          // EncString
    expect(cred!.keyValue).not.toContain(PASSKEY.keyValue);
    // 元数据必须留在明文里，否则别的客户端解不出来
    expect(cred!.rpId).toBe('github.com');
    expect(cred!.credentialId).toBe('aBcD1234');
    expect(cred!.counter).toBe('7');
    expect(cred!.discoverable).toBe('true');
    expect(cred!.userName).toBe('kylin@example.com');
  });

  it('round-trips through encrypt and decrypt unchanged', async () => {
    const body = await encryptCipher(loginItem(), key, {});
    const dto: CipherDto = {
      id: 'c1', type: 1,
      name: await encryptString('GitHub', key),
      notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: null,
      creationDate: '2026-01-01T00:00:00.000000Z',
      revisionDate: '2026-01-01T00:00:00.000000Z',
      deletedDate: null, archivedDate: null,
      login: body.login ?? null,
      fields: [], passwordHistory: [],
    };
    const item = await decryptCipher(dto, key);
    expect(item.login?.fido2Credentials).toEqual([PASSKEY]);
  });

  /** 条目上原本没有 passkey 时，字段是空数组而不是 undefined —— 省得每个调用方都判空 */
  it('always sends fido2Credentials, even when empty', async () => {
    const item = loginItem({ login: emptyLogin() });
    const body = await encryptCipher(item, key, {});
    // ⚠️ 必须发。用户删掉最后一条 passkey 时，不发就等于没删掉
    expect(body.login?.fido2Credentials).toEqual([]);
  });

  it('does not put fido2Credentials on non-login items', async () => {
    const body = await encryptCipher(loginItem({ type: 'secureNote', rawType: 2, login: null }), key, {});
    expect(body.login).toBeUndefined();
  });
});

describe('读 passkey 时的宽容', () => {
  async function dtoWith(creds: CipherFido2CredentialDto[] | null): Promise<CipherDto> {
    return {
      id: 'c1', type: 1,
      name: await encryptString('GitHub', key),
      notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: null,
      creationDate: '2026-01-01T00:00:00.000000Z',
      revisionDate: '2026-01-01T00:00:00.000000Z',
      deletedDate: null, archivedDate: null,
      login: {
        username: null, password: null, totp: null, passwordRevisionDate: null,
        uris: [], fido2Credentials: creds,
      },
      fields: [], passwordHistory: [],
    };
  }

  /**
   * ⚠️ 必须两种都认。
   *
   * `keyValue` 是不是 EncString，取决于**写它的那个客户端**。历史上确实存在
   * 明文存储的版本，用户从别的客户端同步过来的数据里可能就有。
   * 只认加密形态的话，这些条目会表现为「passkey 打不开」，而且很难看出原因。
   *
   * 判别是无歧义的：EncString 形如 `2.iv|data|mac`，而 base64url 的 PKCS#8
   * 里不可能出现 `.`。
   */
  it('accepts a plaintext keyValue from another client', async () => {
    const item = await decryptCipher(await dtoWith([{ ...PASSKEY }]), key);
    expect(item.login?.fido2Credentials?.[0]?.keyValue).toBe(PASSKEY.keyValue);
    expect(item.login?.fido2Credentials?.[0]?.rpId).toBe('github.com');
  });

  it('accepts an encrypted keyValue', async () => {
    const item = await decryptCipher(
      await dtoWith([{ ...PASSKEY, keyValue: await encryptString(PASSKEY.keyValue, key) }]), key);
    expect(item.login?.fido2Credentials?.[0]?.keyValue).toBe(PASSKEY.keyValue);
  });

  it('treats missing or null fido2Credentials as an empty list', async () => {
    for (const v of [null, undefined]) {
      const item = await decryptCipher(await dtoWith(v as null), key);
      expect(item.login?.fido2Credentials).toEqual([]);
    }
  });

  /**
   * ⚠️ 这条凭据的 `keyValue` 是**好的**，只缺 `credentialId`。
   *
   * 必须这么造：如果它同时也缺 keyValue，就会被「私钥读不出来」那条检查兜住，
   * 于是「缺 credentialId 要丢掉」这个判断**无法被单独观测** ——
   * 把那个检查删掉测试照样绿（变异检验抓到的）。
   *
   * 而 credentialId 恰恰是 RP 用来找凭据的键：没有它，这条记录永远匹配不上任何挑战。
   */
  it('drops a credential with no credentialId even when its key is readable', async () => {
    const item = await decryptCipher(
      await dtoWith([{ rpId: 'github.com', keyValue: PASSKEY.keyValue }]), key);
    expect(item.login?.fido2Credentials).toEqual([]);
  });

  /** 缺字段的凭据不该让整条目打不开 —— passkey 是附加功能，笔记和密码还得能用 */
  it('does not fail the whole item because one credential is broken', async () => {
    const item = await decryptCipher(
      await dtoWith([{ rpId: 'github.com' }, { ...PASSKEY, keyValue: null }]), key);
    expect(item.login?.fido2Credentials).toEqual([]);
    expect(item.name).toBe('GitHub');
  });

  /**
   * ⚠️ 一对凭据里缺了私钥，它就是个**死凭据**：RP 那边还认得它，
   * 我们这边却永远签不出名。留在列表里的话，用户点它会得到一句语焉不详的失败。
   * 丢掉它，让「这个站没有可用的 passkey」成为明确的结论。
   */
  it('drops a credential whose keyValue cannot be read', async () => {
    const item = await decryptCipher(
      await dtoWith([{ ...PASSKEY, keyValue: '2.这不是一个合法的-EncString' }]), key);
    expect(item.login?.fido2Credentials).toEqual([]);
  });
});
