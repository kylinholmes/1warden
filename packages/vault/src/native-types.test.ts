import { describe, expect, it } from 'vitest';
import { concatBytes, decryptString, encryptBytes, encryptString, makeUserKey } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { parseBitwardenJson } from './import-json';
import { summaryOf } from './item-display';
import { searchItems } from './search';
import { emptyBankAccount, emptyDriversLicense, emptyPassport, type VaultItem } from './model';

const types = [
  { type: 'bankAccount', raw: 6, shape: emptyBankAccount() },
  { type: 'driversLicense', raw: 7, shape: emptyDriversLicense() },
  { type: 'passport', raw: 8, shape: emptyPassport() },
] as const;
const key = makeUserKey();

function item(): VaultItem {
  return {
    id: 'native-record', type: 'bankAccount', rawType: 6, name: 'Native record', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: null, card: null, identity: null, secureNote: null, sshKey: null,
    bankAccount: null, driversLicense: null, passport: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

function dto(type: number, extra: Record<string, unknown> = {}): CipherDto {
  return {
    id: 'native-record', type, name: null, notes: null, folderId: null, favorite: false,
    reprompt: 0, organizationId: null, key: null, creationDate: '', revisionDate: '',
    deletedDate: null, archivedDate: null, ...extra,
  };
}

describe.each(types)('$type native pipeline', ({ type, raw, shape }) => {
  it('encrypts every field, including dates, and round-trips the exact native block', async () => {
    const plain = Object.fromEntries(Object.keys(shape).map((field) => [field, ` 001-${field} `]));
    const record = { ...item(), type, rawType: raw, [type]: plain } as VaultItem;
    const body = await encryptCipher(record, key, {});
    expect(body.type).toBe(raw);
    const block = body[type] as Record<string, string>;
    for (const [field, value] of Object.entries(plain)) {
      expect(block[field]).toMatch(/^2\./);
      expect(await decryptString(block[field]!, key)).toBe(value);
    }
    const back = await decryptCipher(dto(raw, body), key);
    expect(back.type).toBe(type);
    expect(back[type]).toEqual(plain);
    for (const other of types) if (other.type !== type) expect(body[other.type]).toBeUndefined();
  });

  it('does not drop future encrypted properties during ordinary edits', async () => {
    const field = Object.keys(shape)[0]!;
    const unknown = await encryptString('future secret', key);
    const source = dto(raw, { [type]: { [field]: await encryptString('before', key), future: unknown } });
    const record = await decryptCipher(source, key);
    (record[type] as unknown as Record<string, string | null>)[field] = 'after';
    const body = await encryptCipher(record, key, {});
    const block = body[type] as Record<string, string>;
    expect(block.future).toBe(unknown);
    expect(await decryptString(block[field]!, key)).toBe('after');
    expect('future' in record[type]!).toBe(false);
  });

  it('marks unreadable values and blocks saves rather than overwriting them with null', async () => {
    const field = Object.keys(shape)[0]!;
    const record = await decryptCipher(dto(raw, { [type]: { [field]: '2.broken' } }), key);
    expect((record[type] as unknown as Record<string, string | null>)[field]).toBeNull();
    await expect(encryptCipher(record, key, {})).rejects.toThrow(/无法解密|读取/);
  });

  it('rejects malformed or missing native blocks without inventing a replacement type', async () => {
    for (const block of [null, undefined, false, [], 'invalid']) {
      const record = await decryptCipher(dto(raw, { [type]: block }), key);
      await expect(encryptCipher(record, key, {})).rejects.toThrow(/缺少|无法解密|读取/);
    }
  });

  it('honors the independent item key for the entire new type block', async () => {
    const itemKey = makeUserKey();
    const wrapped = await encryptBytes(concatBytes(itemKey.encKey, itemKey.macKey!), key);
    const field = Object.keys(shape)[0]!;
    const record = await decryptCipher(dto(raw, {
      key: wrapped, [type]: { [field]: await encryptString('independent', itemKey) },
    }), key);
    await expect(encryptCipher(record, key, {})).rejects.toThrow(/密钥/);
    const body = await encryptCipher(record, key, { itemKey });
    expect(body.key).toBe(wrapped);
    expect(await decryptString((body[type] as Record<string, string>)[field]!, itemKey)).toBe('independent');
  });

  it('imports the native JSON block without trimming identifiers or changing dates', () => {
    const plain = Object.fromEntries(Object.keys(shape).map((field) => [field, ` 000-${field} `]));
    const imported = parseBitwardenJson(JSON.stringify({ items: [{ name: 'Imported', type: raw, [type]: plain }] }));
    expect(imported.skipped).toEqual([]);
    expect(imported.items[0]?.type).toBe(type);
    expect(imported.items[0]?.[type]).toEqual(plain);
    const invalid = parseBitwardenJson(JSON.stringify({ items: [{ name: 'Invalid', type: raw, [type]: { [Object.keys(shape)[0]!]: 123 } }] }));
    expect(invalid.items).toEqual([]);
    expect(invalid.skipped).toHaveLength(1);
  });
});

it('keeps bank and document numbers out of list summaries and ordinary native-field search', () => {
  const records: VaultItem[] = [
    { ...item(), bankAccount: { ...emptyBankAccount(), bankName: 'Example Bank', accountNumber: 'secret-account', iban: 'secret-iban', pin: 'secret-pin' } },
    { ...item(), type: 'driversLicense', rawType: 7, driversLicense: { ...emptyDriversLicense(), firstName: 'Alice', licenseNumber: 'secret-license' } },
    { ...item(), type: 'passport', rawType: 8, passport: { ...emptyPassport(), givenName: 'Bob', passportNumber: 'secret-passport', nationalIdentificationNumber: 'secret-identity' } },
  ];
  expect(records.map(summaryOf)).toEqual(['Example Bank', 'Alice', 'Bob']);
  expect(searchItems(records, [], 'secret')).toEqual([]);
  expect(searchItems(records, [], 'Alice')).toHaveLength(1);
});
