import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherDto } from '@coffer/api';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { emptyLogin, emptyCard } from './model';
import type { VaultItem } from './model';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

function item(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'c1', type: 'login', rawType: 1, name: 'GitHub', nameFailed: false,
    notes: '工作账号', notesFailed: false,
    folderId: 'f1', favorite: true, reprompt: 0,
    createdAt: '2026-01-01T00:00:00.000000Z', updatedAt: '2026-01-02T00:00:00.000000Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username: 'kylin', password: 'pw', totp: 'WQIQ25BRKZYCJVYP', uris: [{ uri: 'https://github.com', match: 0 }] },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }],
    passwordHistory: [{ lastUsedDate: '2025-12-01T00:00:00.000000Z', password: 'old' }],
    attachments: [],
    ...over,
  };
}

/** 把 body 当作服务器会返回的形状，回灌给解密 —— 用于往返验证 */
function asDto(original: VaultItem, body: Record<string, unknown>): CipherDto {
  return {
    id: original.id, type: body['type'] as number, name: body['name'] as string,
    notes: (body['notes'] ?? null) as string | null,
    folderId: (body['folderId'] ?? null) as string | null,
    favorite: body['favorite'] as boolean, reprompt: body['reprompt'] as number,
    organizationId: null, key: null,
    creationDate: original.createdAt, revisionDate: original.updatedAt,
    deletedDate: null, archivedDate: null,
    login: (body['login'] ?? null) as never,
    card: (body['card'] ?? null) as never,
    identity: (body['identity'] ?? null) as never,
    secureNote: (body['secureNote'] ?? null) as never,
    fields: (body['fields'] ?? null) as never,
    passwordHistory: (body['passwordHistory'] ?? null) as never,
  };
}

describe('encryptCipher — 必填与两个致命约定', () => {
  // ⚠️ `encryptedFor` 由 @coffer/api 的 createCipher/updateCipher 从**已认证的 userId**
  // 填入，这一层刻意不碰它。两层各司其职：vault 管加密，api 管身份。
  // 让这一层也加一份会造成重复，而且可能填进一个与当前登录用户不符的值 ——
  // 服务端会以 422 "Invalid user cipher" 拒绝，且很难看出为什么。
  it('does not set encryptedFor (the api layer owns it)', async () => {
    expect('encryptedFor' in await encryptCipher(item(), key, {})).toBe(false);
  });

  // ⚠️ 省略 folderId 会让服务端把条目**移出文件夹**
  it('always sends folderId, even when null', async () => {
    const body = await encryptCipher(item({ folderId: null }), key, {});
    expect('folderId' in body).toBe(true);
    expect(body.folderId).toBeNull();
  });

  // ⚠️ archivedDate 语义是反的：null = 取消归档。
  // 默认不带，否则一次普通的改名会把已归档条目悄悄恢复。
  it('omits archivedDate unless explicitly requested', async () => {
    const body = await encryptCipher(item({ archivedAt: '2026-02-01T00:00:00.000000Z' }), key, {});
    expect('archivedDate' in body).toBe(false);
  });

  it('sends archivedDate when explicitly requested', async () => {
    const body = await encryptCipher(item(), key, { archivedDate: '2026-02-01T00:00:00.000000Z' });
    expect(body.archivedDate).toBe('2026-02-01T00:00:00.000000Z');
  });

  it('passes lastKnownRevisionDate through', async () => {
    const body = await encryptCipher(item(), key, { lastKnownRevisionDate: '2026-01-02T00:00:00.000000Z' });
    expect(body.lastKnownRevisionDate).toBe('2026-01-02T00:00:00.000000Z');
  });
});

describe('encryptCipher — 只发匹配类型的子对象', () => {
  it('sends login and nothing else for a login item', async () => {
    const b = await encryptCipher(item(), key, {});
    expect(b.login).toBeTruthy();
    expect(b.card).toBeUndefined();
    expect(b.identity).toBeUndefined();
    expect(b.secureNote).toBeUndefined();
  });

  it('sends card and nothing else for a card item', async () => {
    const b = await encryptCipher(
      item({ type: 'card', rawType: 3, login: null, card: emptyCard() }), key, {});
    expect(b.card).toBeTruthy();
    expect(b.login).toBeUndefined();
  });

  // secureNote 是特例：值固定 { type: 0 } 且**不加密**
  it('sends an unencrypted secureNote marker', async () => {
    const b = await encryptCipher(
      item({ type: 'secureNote', rawType: 2, login: null, secureNote: { type: 0 } }), key, {});
    expect(b.secureNote).toEqual({ type: 0 });
  });

  // 未知类型不允许编辑 —— 保存会把它降级，等于破坏数据
  it('refuses to save an unknown type', async () => {
    await expect(encryptCipher(item({ type: 'unknown', rawType: 7 }), key, {}))
      .rejects.toThrow(/未知/);
  });
});

describe('encryptCipher — 往返一致', () => {
  // 最关键的一条：加密后再解密必须回到原值。任何漏掉的字段都会在这里现形。
  it('round-trips a full login item', async () => {
    const original = item();
    const back = await decryptCipher(asDto(original, await encryptCipher(original, key, {}) as never), key);

    expect(back.name).toBe(original.name);
    expect(back.notes).toBe(original.notes);
    expect(back.login?.username).toBe('kylin');
    expect(back.login?.password).toBe('pw');
    expect(back.login?.totp).toBe('WQIQ25BRKZYCJVYP');
    expect(back.login?.uris[0]?.uri).toBe('https://github.com');
    expect(back.login?.uris[0]?.match).toBe(0);
    expect(back.customFields[0]?.name).toBe('PIN');
    expect(back.customFields[0]?.value).toBe('1234');
    expect(back.passwordHistory[0]?.password).toBe('old');
    expect(back.folderId).toBe('f1');
    expect(back.favorite).toBe(true);
  });

  it('round-trips Chinese text and emoji', async () => {
    const original = item({ name: '淘宝 🔐 账号', notes: '中文备注' });
    const body = await encryptCipher(original, key, {});
    expect(body.name).not.toBe(original.name); // 确实是密文
    expect((await decryptCipher(asDto(original, body as never), key)).name).toBe('淘宝 🔐 账号');
  });

  it('round-trips an empty string without turning it into null', async () => {
    const original = item({ login: { ...emptyLogin(), username: '', password: null } });
    const body = await encryptCipher(original, key, {});
    const back = await decryptCipher(asDto(original, body as never), key);
    expect(back.login?.username).toBe('');
    expect(back.login?.password).toBeNull();
  });

  it('round-trips a card item', async () => {
    const original = item({
      type: 'card', rawType: 3, login: null,
      card: { ...emptyCard(), brand: 'Visa', number: '4111111111111111', expMonth: '12', expYear: '2030' },
    });
    const back = await decryptCipher(asDto(original, await encryptCipher(original, key, {}) as never), key);
    expect(back.card?.brand).toBe('Visa');
    expect(back.card?.expMonth).toBe('12');
  });
});

describe('encryptCipher — 拒绝写坏数据', () => {
  // 名解不开的条目若原样保存，会把「无法解密」写成一个真实的密文，反而破坏数据
  it('refuses to save an item whose name failed to decrypt', async () => {
    await expect(encryptCipher(item({ nameFailed: true, name: '' }), key, {}))
      .rejects.toThrow(/无法解密/);
  });
});
