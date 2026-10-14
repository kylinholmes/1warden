import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { createVaultExport } from './export';
import { isEncryptedJsonExport } from './import-encrypted';
import { detectImportFormat, parseImport } from './import-dispatch';
import { emptyBankAccount, emptyCard, emptyDriversLicense, emptyIdentity, emptyLogin, emptyPassport, emptySshKey, type VaultItem } from './model';
import { buildProfileItem } from './profile';
import { parseCsv } from './csv';
import { encryptString, makeUserKey } from '@1warden/crypto';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const item = (over: Partial<VaultItem> = {}): VaultItem => ({
  id: 'item', type: 'login', rawType: 1, name: 'A, "login"', nameFailed: false,
  notes: '  first\nsecond  ', notesFailed: false, folderId: 'folder', favorite: true,
  reprompt: 1, createdAt: '2026-01-01', updatedAt: '2026-02-01', deletedAt: null,
  archivedAt: null, wrappedKey: 'internal-wrapped-key',
  login: { ...emptyLogin(), username: ' user ', password: ' pass ', autofillOnPageLoad: false,
    uris: [{ uri: 'https://example.com', match: 3, sourceId: 'internal-uri' }],
    passwordRevisionDate: '2026-01-02', fido2Credentials: [{ sourceId: 'internal-passkey',
      credentialId: 'credential', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
      keyValue: 'synthetic-private-key', rpId: 'example.com', userName: 'user', counter: '2',
      discoverable: 'true', creationDate: '2026-01-03' }] },
  card: null, identity: null, sshKey: null, secureNote: null,
  customFields: [{ name: 'enabled', value: 'true', type: 2, linkedId: null, sourceId: 'internal-field' },
    { name: 'username', value: '', type: 3, linkedId: 100 }],
  passwordHistory: [{ password: ' old ', lastUsedDate: '2025-01-01', sourceId: 'internal-history' }],
  attachments: [], ...over,
});
const folders = [{ id: 'folder', name: '工作', nameFailed: false, updatedAt: '2026-01-01' }];

// Independent Node/OpenSSL implementation of the documented Bitwarden envelope.
// Deliberately never calls the production KDF/encryption helpers.
function referenceKey(password: string, salt: string, iterations: number) {
  const raw = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return { enc: createHmac('sha256', raw).update(Buffer.from('enc\x01')).digest(),
    mac: createHmac('sha256', raw).update(Buffer.from('mac\x01')).digest() };
}
function referenceEncrypt(value: string, key: ReturnType<typeof referenceKey>) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-256-cbc', key.enc, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  return `2.${iv.toString('base64')}|${data.toString('base64')}|${mac.toString('base64')}`;
}
function referenceDecrypt(value: string, key: ReturnType<typeof referenceKey>) {
  const [iv, data, mac] = value.slice(2).split('|').map(part => Buffer.from(part, 'base64'));
  expect(createHmac('sha256', key.mac).update(Buffer.concat([iv!, data!])).digest()).toEqual(mac);
  const cipher = createDecipheriv('aes-256-cbc', key.enc, iv!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString('utf8');
}
function referenceFile() {
  const salt = 'AbCdEF0123456789+/abC==';
  const key = referenceKey('export password', salt, 1000);
  return { encrypted: true, passwordProtected: true, salt, kdfType: 0, kdfIterations: 1000,
    encKeyValidation_DO_NOT_EDIT: referenceEncrypt('00000000-0000-4000-8000-000000000001', key),
    data: referenceEncrypt(JSON.stringify({ encrypted: false, folders: [], items: [
      { name: 'External', type: 1, login: { username: 'external', password: ' password ' } },
    ] }), key) };
}

describe('vault exports', () => {
  it('round trips every supported login field without internal state or secret envelopes', async () => {
    const source = item();
    source.preservation = { source: { accessToken: 'never-export-token', futureProperty: '2.ciphertext' } as never,
      baseline: structuredClone(source), failures: [] };
    const result = await createVaultExport({ items: [source], folders, format: 'json' });
    expect(result).toMatchObject({ itemCount: 1, folderCount: 1 });
    const json = JSON.parse(text(result.bytes));
    expect(json.items[0]).toMatchObject({ type: 1, creationDate: '2026-01-01', revisionDate: '2026-02-01', reprompt: 1 });
    for (const forbidden of ['internal-', 'never-export-token', 'preservation', 'futureProperty', 'sourceId', 'wrappedKey']) {
      expect(text(result.bytes)).not.toContain(forbidden);
    }
    const imported = await parseImport(result.bytes);
    expect(imported.skipped).toEqual([]);
    expect(imported.items[0]).toMatchObject({ name: 'A, "login"', notes: '  first\nsecond  ', folderName: '工作',
      reprompt: 1, login: { username: ' user ', password: ' pass ', autofillOnPageLoad: false,
        passwordRevisionDate: '2026-01-02', uris: [{ uri: 'https://example.com', match: 3 }],
        fido2Credentials: [{ credentialId: 'credential', keyValue: 'synthetic-private-key', counter: '2' }] },
      customFields: [{ name: 'enabled', value: 'true', type: 2 }, { name: 'username', value: '', type: 3, linkedId: 100 }],
      passwordHistory: [{ password: ' old ', lastUsedDate: '2025-01-01' }] });
    expect(result.warnings.join(' ')).toMatch(/未知|未支持/);
  });

  it('excludes trash, internal profile and organization records with visible counts', async () => {
    const org = item({ id: 'org' });
    org.preservation = { source: { organizationId: 'org' } as never, baseline: structuredClone(org), failures: [] };
    const result = await createVaultExport({ items: [item(), item({ deletedAt: '2026-01-01' }),
      { ...buildProfileItem({ displayName: 'Private', avatarDataUrl: null }), id: 'profile' }, org], folders, format: 'json' });
    expect(JSON.parse(text(result.bytes)).items).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/组织/);
  });

  it('blocks incomplete exports when a record or folder cannot be read', async () => {
    await expect(createVaultExport({ items: [item({ nameFailed: true })], folders, format: 'json' })).rejects.toThrow(/无法.*读取|无法.*解密/);
    await expect(createVaultExport({ items: [item()], folders: [{ ...folders[0]!, nameFailed: true }], format: 'json' })).rejects.toThrow(/文件夹/);
    await expect(createVaultExport({ items: [item({ type: 'unknown', rawType: 99 })], folders, format: 'json' })).rejects.toThrow(/不支持|未知/);
  });

  it('exports the CSV subset with escaped cells and reports all format losses', async () => {
    const result = await createVaultExport({ items: [item(), item({ type: 'card', rawType: 3, card: emptyCard() })], folders, format: 'csv' });
    const rows = parseCsv(text(result.bytes));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[3]).toBe('A, "login"');
    expect(rows[1]?.[4]).toBe('  first\nsecond  ');
    expect(result.itemCount).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/CSV/);
    expect(result.warnings.join(' ')).toMatch(/通行密钥|passkey/i);
    expect(result.warnings.join(' ')).toMatch(/历史/);
    expect(result.warnings.join(' ')).toMatch(/1.*条/);
    const imported = await parseImport(result.bytes);
    expect(imported.items[0]).toMatchObject({ reprompt: 1, notes: '  first\nsecond  ',
      login: { username: ' user ', password: ' pass ' } });
  });

  it('never bundles attachment URLs, keys or metadata and reports attachment omissions', async () => {
    const result = await createVaultExport({ items: [item({ attachments: [{ id: 'attachment', fileName: 'secret.pdf',
      size: '10', sizeName: '10 B', url: 'https://example.com/signed-token', key: 'attachment-key', failed: false }] })], folders, format: 'json' });
    expect(text(result.bytes)).not.toContain('signed-token');
    expect(text(result.bytes)).not.toContain('attachment-key');
    expect(text(result.bytes)).not.toContain('secret.pdf');
    expect(result.warnings.join(' ')).toMatch(/附件/);
  });

  it('preserves all supported structured item types', async () => {
    const records = [
      item({ type: 'secureNote', rawType: 2, login: null, secureNote: { type: 0 } }),
      item({ type: 'card', rawType: 3, login: null, card: { ...emptyCard(), number: '00001234', code: ' 123 ' } }),
      item({ type: 'identity', rawType: 4, login: null, identity: { ...emptyIdentity(), firstName: ' 名 ', ssn: '001' } }),
      item({ type: 'sshKey', rawType: 5, login: null, sshKey: { ...emptySshKey(), privateKey: 'KEY\nEND\n' } }),
      item({ type: 'bankAccount', rawType: 6, login: null, bankAccount: { ...emptyBankAccount(), accountNumber: '00001' } }),
      item({ type: 'driversLicense', rawType: 7, login: null, driversLicense: { ...emptyDriversLicense(), licenseNumber: '00002' } }),
      item({ type: 'passport', rawType: 8, login: null, passport: { ...emptyPassport(), passportNumber: '00003' } }),
    ];
    const exported = await createVaultExport({ items: records, folders, format: 'json' });
    const imported = await parseImport(exported.bytes);
    expect(imported.skipped).toEqual([]);
    expect(imported.items.map(row => row.type)).toEqual(['secureNote', 'card', 'identity', 'sshKey', 'bankAccount', 'driversLicense', 'passport']);
    expect(imported.items[1]?.card).toMatchObject({ number: '00001234', code: ' 123 ' });
    expect(imported.items[2]?.identity).toMatchObject({ firstName: ' 名 ', ssn: '001' });
    expect(imported.items[3]?.sshKey?.privateKey).toBe('KEY\nEND\n');
    expect(imported.items[4]?.bankAccount?.accountNumber).toBe('00001');
    expect(imported.items[5]?.driversLicense?.licenseNumber).toBe('00002');
    expect(imported.items[6]?.passport?.passportNumber).toBe('00003');
  });

  it('reports unmodeled nested native fields without copying their ciphertext', async () => {
    const source = item();
    source.preservation = { source: { login: { futureSecret: '2.unreadable-ciphertext' } } as never,
      baseline: structuredClone(source), failures: [] };
    const exported = await createVaultExport({ items: [source], folders, format: 'json' });
    expect(text(exported.bytes)).not.toContain('unreadable-ciphertext');
    expect(exported.warnings.join(' ')).toMatch(/未知|未支持/);
  });

  it('does not silently create an unprotected file when the export password is missing', async () => {
    await expect(createVaultExport({ items: [item()], folders, format: 'encrypted-json' })).rejects.toThrow(/密码/);
  });

  it('preserves actual decrypted passkey algorithm metadata from other clients', async () => {
    const key = makeUserKey();
    const dto = { ...await encryptCipher(item({ wrappedKey: null }), key, {}), id: 'record', creationDate: '', revisionDate: '',
      deletedDate: null, archivedDate: null, key: null };
    dto.login!.fido2Credentials![0]!.keyAlgorithm = await encryptString('RSA', key);
    dto.login!.fido2Credentials![0]!.keyCurve = await encryptString('P-384', key);
    const decoded = await decryptCipher(dto as never, key);
    const exported = await createVaultExport({ items: [decoded], folders, format: 'json' });
    expect(JSON.parse(text(exported.bytes)).items[0].login.fido2Credentials[0])
      .toMatchObject({ keyAlgorithm: 'RSA', keyCurve: 'P-384' });
  });

  it('produces a portable password encrypted envelope decryptable independently', { timeout: 30_000 }, async () => {
    const result = await createVaultExport({ items: [item()], folders, format: 'encrypted-json', password: 'independent password' });
    expect(result.filename).toMatch(/encrypted.*\.json$/);
    const envelope = JSON.parse(text(result.bytes));
    expect(envelope).toMatchObject({ encrypted: true, passwordProtected: true, kdfType: 0 });
    expect(envelope.kdfIterations).toBeGreaterThanOrEqual(600000);
    const key = referenceKey('independent password', envelope.salt, envelope.kdfIterations);
    expect(referenceDecrypt(envelope.encKeyValidation_DO_NOT_EDIT, key)).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(referenceDecrypt(envelope.data, key)).items[0].login.password).toBe(' pass ');
    expect(text(result.bytes)).not.toContain('synthetic-private-key');
    expect((await parseImport(result.bytes, 'auto', 'independent password')).items[0]?.login?.password).toBe(' pass ');
  });
});

describe('password encrypted imports', () => {
  it('recognizes and imports a case-sensitive independently encrypted fixture', async () => {
    const data = bytes(JSON.stringify(referenceFile()));
    expect(isEncryptedJsonExport(data)).toBe(true);
    expect(detectImportFormat(data)).toBe('bitwarden-json');
    expect((await parseImport(data, 'auto', 'export password')).items[0]?.login?.password).toBe(' password ');
  });

  it('recognizes JSON larger than the sniff prefix', async () => {
    const data = bytes(JSON.stringify({ encrypted: false, folders: [], items: [{ type: 2, name: 'Large', notes: 'x'.repeat(9000) }] }));
    expect(detectImportFormat(data)).toBe('bitwarden-json');
    expect((await parseImport(data)).items).toHaveLength(1);
  });

  it('allows wrong-password retry without replacing or mutating the input', async () => {
    const data = bytes(JSON.stringify(referenceFile()));
    await expect(parseImport(data)).rejects.toThrow(/密码/);
    await expect(parseImport(data, 'auto', 'wrong')).rejects.toThrow(/密码.*错误|密码.*不正确/);
    expect((await parseImport(data, 'auto', 'export password')).items).toHaveLength(1);
  });

  it('rejects account-restricted and malformed envelopes before doing cryptographic work', async () => {
    await expect(parseImport(bytes(JSON.stringify({ encrypted: true, passwordProtected: false })))).rejects.toThrow(/账户|账号/);
    const malformed = { ...referenceFile(), data: 'invalid' };
    await expect(parseImport(bytes(JSON.stringify(malformed)), 'auto', 'export password')).rejects.toThrow(/格式|损坏/);
  });

  it.each([
    { kdfIterations: 0 }, { kdfIterations: -1 }, { kdfIterations: 1.5 }, { kdfIterations: 1000000000 },
    { kdfType: 5 }, { kdfType: 1, kdfIterations: 3, kdfMemory: 999999, kdfParallelism: 4 },
    { kdfType: 1, kdfIterations: 100, kdfMemory: 64, kdfParallelism: 4 },
    { kdfType: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 100 },
  ])('rejects invalid or unreasonably expensive KDF parameters: %j', async params => {
    const data = bytes(JSON.stringify({ ...referenceFile(), ...params }));
    await expect(parseImport(data, 'auto', 'export password')).rejects.toThrow(/KDF/);
  });
});
