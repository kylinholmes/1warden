import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey, encryptString } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherDto } from '@coffer/api';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { emptySshKey, type VaultItem } from './model';
import { parseBitwardenJson } from './import-json';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@host';
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function sshItem(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 's1', type: 'sshKey', rawType: 5, name: '部署密钥', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: null, card: null, identity: null, secureNote: null,
    sshKey: { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT },
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

async function sshDto(over: Record<string, unknown> = {}): Promise<CipherDto> {
  return ({
    id: 's1', type: 5,
    name: await encryptString('部署密钥', key),
    notes: null, folderId: null, favorite: false, reprompt: 0,
    organizationId: null, key: null,
    creationDate: '', revisionDate: '', deletedDate: null, archivedDate: null,
    sshKey: {
      privateKey: await encryptString(PRIVATE_KEY, key),
      publicKey: await encryptString(PUBLIC_KEY, key),
      fingerprint: await encryptString(FINGERPRINT, key),
    },
    ...over,
  }) as CipherDto;
}

/**
 * ⚠️ SSH key 此前是一个**空壳**：类型列表里有它、列表图标有 🔧、标签写着
 * 「SSH 密钥」，但没有字段组、没有加解密、详情页也没有渲染。
 *
 * 更糟的是导入路径：Bitwarden 的 JSON 里 type 5 落到 `default → secureNote`，
 * 而内容在 `sshKey` 字段里没人读 —— 用户导入后拿到一条**标题正确、内容全空**
 * 的笔记，看起来像数据丢了。这比「不支持」更糟。
 */
describe('SSH key —— 三个字段都是 EncString', () => {
  it('decrypts the private key, public key and fingerprint', async () => {
    const item = await decryptCipher(await sshDto(), key);
    expect(item.type).toBe('sshKey');
    expect(item.sshKey).toEqual({
      privateKey: PRIVATE_KEY,
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
  });

  it('round-trips through encrypt and decrypt', async () => {
    const body = await encryptCipher(sshItem(), key, {});
    const dto = {
      id: 's1', type: 5,
      name: await encryptString('部署密钥', key),
      notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: null,
      creationDate: '', revisionDate: '', deletedDate: null, archivedDate: null,
      sshKey: body.sshKey ?? null,
      fields: [], passwordHistory: [],
    } as CipherDto;
    const back = await decryptCipher(dto, key);
    expect(back.sshKey).toEqual(sshItem().sshKey);
  });

  /** 私钥绝不能被当成普通字段——写错了它会明文躺在服务端 */
  it('encrypts all three fields', async () => {
    const body = await encryptCipher(sshItem(), key, {});
    const ssh = body.sshKey as Record<string, string>;
    for (const [k, plain] of Object.entries({
      privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT,
    })) {
      expect(ssh[k]).toMatch(/^2\./);
      expect(ssh[k]).not.toContain(plain);
    }
  });

  it('sends no other cipher body for an SSH key item', async () => {
    const body = await encryptCipher(sshItem(), key, {});
    expect(body.login).toBeUndefined();
    expect(body.card).toBeUndefined();
    expect(body.identity).toBeUndefined();
    expect(body.secureNote).toBeUndefined();
  });

  /** 缺字段要单独处理 —— 三个都给 null 解出来的 SSH key 条目是空壳 */
  it('treats missing or null fields as null rather than failing', async () => {
    const dto = await sshDto({ sshKey: { privateKey: null, publicKey: null, fingerprint: null } });
    const item = await decryptCipher(dto, key);
    expect(item.type).toBe('sshKey');
    expect(item.sshKey).toEqual(emptySshKey());
  });

  it('keeps the item readable when one field cannot be decrypted', async () => {
    const dto = await sshDto({ sshKey: { privateKey: '2.坏的|坏的|坏的', publicKey: null, fingerprint: null } });
    const item = await decryptCipher(dto, key);
    // 解不开就是 null，但条目本身和另外两个字段都还在
    expect(item.name).toBe('部署密钥');
    expect(item.sshKey?.privateKey).toBeNull();
  });

  it('does not put an sshKey block on other item types', async () => {
    const login = sshItem({ type: 'login', rawType: 1, sshKey: null,
      login: { username: 'u', password: 'p', totp: null, uris: [], passwordRevisionDate: null, fido2Credentials: [] } });
    expect((await encryptCipher(login, key, {})).sshKey).toBeUndefined();
  });
});

describe('从 Bitwarden JSON 导入 SSH key', () => {
  /**
   * ⚠️ 这条是本次修复的核心：原先 type 5 落到 `secureNote`，
   * 而 `sshKey` 字段**没人读** —— 私钥、公钥、指纹全部静默丢失。
   */
  it('reads the sshKey block instead of dropping it', async () => {
    const json = JSON.stringify({ encrypted: false, folders: [], items: [
      { id: 's1', type: 5, name: '部署密钥', favorite: false, notes: '备注',
        sshKey: { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT } },
    ] });
    const r = parseBitwardenJson(json);
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: '部署密钥', type: 'sshKey',
      sshKey: { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT },
    });
  });

  /** 认不出的类型仍然当笔记 —— 但**内容要留住** */
  it('still falls back to a note for a type we do not model', () => {
    const json = JSON.stringify({ encrypted: false, folders: [], items: [
      { id: 'b1', type: 6, name: '银行账户', notes: '账号在备注里', favorite: false },
    ] });
    expect(parseBitwardenJson(json).items[0]).toMatchObject({ name: '银行账户', type: 'secureNote' });
  });
});
