import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey, encryptString, encryptBytes } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { decryptCipher, decryptFolder } from './decrypt';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

/** 构造一条「所有敏感字段都加密了」的登录条目 —— 用来验证我们没有漏字段 */
async function fullLoginDto(over: Partial<CipherDto> = {}): Promise<CipherDto> {
  return {
    id: 'c1', type: 1,
    name: await encryptString('GitHub', key),
    notes: await encryptString('工作账号', key),
    folderId: 'f1', favorite: true, reprompt: 0,
    organizationId: null, key: null,
    creationDate: '2026-01-01T00:00:00.000000Z',
    revisionDate: '2026-01-02T00:00:00.000000Z',
    deletedDate: null, archivedDate: null,
    login: {
      username: await encryptString('kylin@example.com', key),
      password: await encryptString('hunter2', key),
      totp: await encryptString('otpauth://totp/GitHub:kylin?secret=WQIQ25BRKZYCJVYP', key),
      passwordRevisionDate: '2026-01-01T00:00:00.000000Z',
      uris: [{ uri: await encryptString('https://github.com', key), match: 0 }],
    },
    fields: [
      { name: await encryptString('PIN', key), value: await encryptString('1234', key), type: 1, linkedId: null },
    ],
    passwordHistory: [
      { lastUsedDate: '2025-12-01T00:00:00.000000Z', password: await encryptString('old-pw', key) },
    ],
    ...over,
  };
}

describe('decryptCipher — 字段全集', () => {
  // 这条测试的价值在于**穷举**：任何遗漏的字段都会在这里暴露为 null 或空白
  it('decrypts every encrypted field of a login item', async () => {
    const item = await decryptCipher(await fullLoginDto(), key);
    expect(item.name).toBe('GitHub');
    expect(item.nameFailed).toBe(false);
    expect(item.notes).toBe('工作账号');
    expect(item.login?.username).toBe('kylin@example.com');
    expect(item.login?.password).toBe('hunter2');
    expect(item.login?.totp).toContain('otpauth://');
    expect(item.login?.uris[0]?.uri).toBe('https://github.com');
    expect(item.customFields[0]?.name).toBe('PIN');
    expect(item.customFields[0]?.value).toBe('1234');
    expect(item.passwordHistory[0]?.password).toBe('old-pw');
  });

  it('passes through the plaintext fields unchanged', async () => {
    const item = await decryptCipher(await fullLoginDto(), key);
    expect(item.id).toBe('c1');
    expect(item.type).toBe('login');
    expect(item.rawType).toBe(1);
    expect(item.folderId).toBe('f1');
    expect(item.favorite).toBe(true);
    expect(item.reprompt).toBe(0);
    expect(item.updatedAt).toBe('2026-01-02T00:00:00.000000Z');
    expect(item.login?.uris[0]?.match).toBe(0);
    expect(item.login?.passwordRevisionDate).toBe('2026-01-01T00:00:00.000000Z');
    expect(item.customFields[0]?.type).toBe(1);
  });

  it('decrypts card fields, keeping brand as a string', async () => {
    const dto = await fullLoginDto({
      type: 3, login: null,
      card: {
        cardholderName: await encryptString('Kylin', key),
        brand: await encryptString('Visa', key),
        number: await encryptString('4111111111111111', key),
        expMonth: await encryptString('12', key),
        expYear: await encryptString('2030', key),
        code: await encryptString('123', key),
      },
    });
    const item = await decryptCipher(dto, key);
    expect(item.type).toBe('card');
    expect(item.card?.brand).toBe('Visa');
    expect(item.card?.number).toBe('4111111111111111');
    expect(item.login).toBeNull();
  });

  it('decrypts identity fields and nulls the ones not provided', async () => {
    const dto = await fullLoginDto({
      type: 4, login: null,
      identity: {
        firstName: await encryptString('Kylin', key),
        ssn: await encryptString('000-00-0000', key),
      },
    });
    const item = await decryptCipher(dto, key);
    expect(item.identity?.firstName).toBe('Kylin');
    expect(item.identity?.ssn).toBe('000-00-0000');
    expect(item.identity?.lastName).toBeNull();
  });

  it('decrypts attachment file names and keeps the attachment key as ciphertext', async () => {
    const dto = await fullLoginDto({
      attachments: [{
        id: 'a1',
        url: 'https://x/attachments/c1/a1?token=t',
        fileName: await encryptString('身份证.png', key),
        size: '12345', sizeName: '12 KB',
        key: await encryptString('not-a-real-key', key),
      }],
    });
    const item = await decryptCipher(dto, key);
    expect(item.attachments[0]?.fileName).toBe('身份证.png');
    expect(item.attachments[0]?.failed).toBe(false);
    // 附件密钥本身仍是密文，解密它需要单独的路径
    expect(item.attachments[0]?.key).toBeTruthy();
    expect(item.attachments[0]?.size).toBe('12345');
  });
});

describe('decryptCipher — null 与缺失字段', () => {
  it('handles a login item with no username', async () => {
    const dto = await fullLoginDto({ login: { username: null, password: await encryptString('pw', key) } });
    const item = await decryptCipher(dto, key);
    expect(item.login?.username).toBeNull();
    expect(item.login?.password).toBe('pw');
  });

  it('handles null notes, missing fields, missing history, missing attachments', async () => {
    const dto = await fullLoginDto({
      notes: null, fields: null, passwordHistory: null, attachments: null,
    });
    const item = await decryptCipher(dto, key);
    expect(item.notes).toBeNull();
    expect(item.notesFailed).toBe(false);
    expect(item.customFields).toEqual([]);
    expect(item.passwordHistory).toEqual([]);
    expect(item.attachments).toEqual([]);
  });

  it('handles an item whose type-specific object is entirely absent', async () => {
    const dto = await fullLoginDto({ type: 2, login: null, secureNote: { type: 0 } });
    const item = await decryptCipher(dto, key);
    expect(item.login).toBeNull();
    expect(item.secureNote).toEqual({ type: 0 });
  });

  it('round-trips an empty string (it is a legitimate value, not null)', async () => {
    const dto = await fullLoginDto({ login: { username: await encryptString('', key), password: null } });
    expect((await decryptCipher(dto, key)).login?.username).toBe('');
  });

  it('handles an item with no uris array at all', async () => {
    const dto = await fullLoginDto({ login: { username: null, password: null } });
    expect((await decryptCipher(dto, key)).login?.uris).toEqual([]);
  });
});

describe('decryptCipher — 每条目独立密钥', () => {
  it('uses the item key for every field when cipher.key is present', async () => {
    const itemKey = makeUserKey();
    const wrapped = await encryptBytes(new Uint8Array([...itemKey.encKey, ...itemKey.macKey]), key);
    const dto: CipherDto = {
      id: 'c9', type: 1,
      name: await encryptString('ItemKeyed', itemKey),   // ← 用条目密钥加密
      notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: wrapped,                 // ← 条目密钥本身用用户密钥包装
      creationDate: '2026-01-01T00:00:00.000000Z',
      revisionDate: '2026-01-01T00:00:00.000000Z',
      deletedDate: null, archivedDate: null,
      login: { username: await encryptString('u', itemKey), password: await encryptString('p', itemKey) },
    };
    const item = await decryptCipher(dto, key);
    expect(item.wrappedKey).not.toBeNull();
    expect(item.name).toBe('ItemKeyed');
    expect(item.login?.username).toBe('u');
    expect(item.login?.password).toBe('p');
  });

  it('falls back to the user key when cipher.key is null', async () => {
    expect((await decryptCipher(await fullLoginDto(), key)).wrappedKey).toBeNull();
  });
});

describe('decryptCipher — 按字段降级', () => {
  // ⚠️ 单个字段解不开**不应**让整条条目不可用。
  // 用户的密码可能还是好的，只是某个自定义字段坏了。
  it('marks only the failing field, not the whole item', async () => {
    const other = makeUserKey();
    const dto = await fullLoginDto({
      login: { username: await encryptString('good', key), password: await encryptString('bad', other) },
    });
    const item = await decryptCipher(dto, key);
    expect(item.login?.username).toBe('good');
    expect(item.login?.password).toBeNull();
    expect(item.nameFailed).toBe(false);
    expect(item.name).toBe('GitHub');
  });

  it('marks a failing name without discarding the rest of the item', async () => {
    const other = makeUserKey();
    const dto = await fullLoginDto({ name: await encryptString('bad', other) });
    const item = await decryptCipher(dto, key);
    expect(item.nameFailed).toBe(true);
    expect(item.name).toBe('');
    expect(item.login?.password).toBe('hunter2');
  });

  it('treats a malformed EncString the same way (no throw)', async () => {
    const dto = await fullLoginDto({ notes: '2.not|valid|base64!!' });
    const item = await decryptCipher(dto, key);
    expect(item.notesFailed).toBe(true);
    expect(item.notes).toBeNull();
  });

  it('keeps a good custom field when its neighbour is broken', async () => {
    const other = makeUserKey();
    const dto = await fullLoginDto({
      fields: [
        { name: await encryptString('good', key), value: await encryptString('v', key), type: 0, linkedId: null },
        { name: await encryptString('bad', other), value: await encryptString('v', key), type: 0, linkedId: null },
      ],
    });
    const item = await decryptCipher(dto, key);
    expect(item.customFields).toHaveLength(2);
    expect(item.customFields[0]?.name).toBe('good');
  });

  it('normalises an out-of-range field type to Hidden (1), matching the server', async () => {
    const dto = await fullLoginDto({
      fields: [{ name: await encryptString('x', key), value: await encryptString('y', key), type: 99, linkedId: null }],
    });
    expect((await decryptCipher(dto, key)).customFields[0]?.type).toBe(1);
  });

  it('skips a password-history entry whose password cannot be decrypted', async () => {
    const other = makeUserKey();
    const dto = await fullLoginDto({
      passwordHistory: [
        { lastUsedDate: '2025-12-01T00:00:00.000000Z', password: await encryptString('ok', key) },
        { lastUsedDate: '2025-11-01T00:00:00.000000Z', password: await encryptString('bad', other) },
      ],
    });
    expect((await decryptCipher(dto, key)).passwordHistory).toHaveLength(1);
  });
});

describe('decryptFolder', () => {
  it('decrypts the folder name', async () => {
    const f = await decryptFolder(
      { id: 'f1', name: await encryptString('工作', key), revisionDate: '2026-01-01T00:00:00.000000Z' },
      key,
    );
    expect(f.name).toBe('工作');
    expect(f.nameFailed).toBe(false);
    expect(f.updatedAt).toBe('2026-01-01T00:00:00.000000Z');
  });

  it('marks a failing folder name without throwing', async () => {
    const f = await decryptFolder(
      { id: 'f1', name: await encryptString('x', makeUserKey()), revisionDate: 'x' },
      key,
    );
    expect(f.nameFailed).toBe(true);
    expect(f.name).toBe('');
  });

  it('handles a null folder name', async () => {
    const f = await decryptFolder({ id: 'f1', name: null, revisionDate: 'x' }, key);
    expect(f.name).toBe('');
    expect(f.nameFailed).toBe(false);
  });
});
