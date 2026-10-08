import { describe, it, expect } from 'vitest';
import { encryptString, encryptBytes, makeUserKey, concatBytes, decryptString } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';

const key = makeUserKey();
async function fixture(extra: Record<string, unknown> = {}): Promise<CipherDto> {
  return {
    id: 'c1', type: 1, name: await encryptString('Name', key), notes: null,
    folderId: null, organizationId: 'org1', favorite: false, reprompt: 0, key: null,
    creationDate: '2026-01-01', revisionDate: '2026-01-02', deletedDate: null, archivedDate: null,
    login: { username: await encryptString('user', key), uris: [
      { uri: await encryptString('https://first.test', key), match: 0 },
      { uri: await encryptString('https://second.test', key), match: 3, uriChecksum: 'opaque-checksum', future: 'second' } as never,
    ], autofillOnPageLoad: true, futurePreference: { enabled: true } } as never,
    collectionIds: ['collection1'], futureTop: { value: 'opaque' }, ...extra,
  } as CipherDto;
}

describe('lossless editing', () => {
  it('preserves ownership and nested unknown fields after editing and removing the first URL', async () => {
    const item = await decryptCipher(await fixture(), key);
    item.name = 'Renamed';
    item.login!.uris.splice(0, 1);
    const body = await encryptCipher(item, key, {});
    expect(body.organizationId).toBe('org1');
    expect((body as any).collectionIds).toEqual(['collection1']);
    expect((body as any).futureTop).toEqual({ value: 'opaque' });
    expect((body.login as any).futurePreference).toEqual({ enabled: true });
    expect(body.login!.autofillOnPageLoad).toBe(true);
    expect(body.login!.uris).toHaveLength(1);
    expect((body.login!.uris![0] as any).future).toBe('second');
    expect(body.login!.uris![0]!.uriChecksum).toBe('opaque-checksum');
    expect(await decryptString(body.name, key)).toBe('Renamed');
  });

  it('preserves unsupported custom fields verbatim and honors explicit deletion', async () => {
    const field = { name: await encryptString('future', key), value: await encryptString('opaque', key), type: 12, linkedId: 888, extra: 'keep' };
    const item = await decryptCipher(await fixture({ fields: [field] }), key);
    expect((await encryptCipher(item, key, {})).fields).toEqual([field]);
    item.customFields = [];
    expect((await encryptCipher(item, key, {})).fields).toBeNull();
  });

  it('blocks destructive saves when supported fields cannot decrypt', async () => {
    for (const extra of [
      { notes: '2.broken' },
      { login: { password: '2.broken' } },
      { fields: [{ name: '2.broken', value: null, type: 0 }] },
      { passwordHistory: [{ password: '2.broken', lastUsedDate: 'today' }] },
      { login: { fido2Credentials: [{ credentialId: 'id', keyValue: '2.broken' }] } },
    ]) {
      const item = await decryptCipher(await fixture(extra), key);
      await expect(encryptCipher(item, key, {})).rejects.toThrow(/无法解密|读取/);
    }
  });

  it('emits the wrapped independent key and refuses wrong-key encryption', async () => {
    const itemKey = makeUserKey();
    const wrapped = await encryptBytes(concatBytes(itemKey.encKey, itemKey.macKey!), key);
    const item = await decryptCipher(await fixture({ key: wrapped, name: await encryptString('Independent', itemKey), login: null }), key);
    await expect(encryptCipher(item, key, {})).rejects.toThrow(/密钥/);
    const body = await encryptCipher(item, key, { itemKey });
    expect(body.key).toBe(wrapped);
    expect(await decryptString(body.name, itemKey)).toBe('Independent');
  });
});

it('recomputes native URL checksum after editing a URL and retains unrelated row data', async () => {
  const item = await decryptCipher(await fixture(), key);
  item.login!.uris[1]!.uri = 'https://changed.test';
  const body = await encryptCipher(item, key, {});
  expect((body.login!.uris![1] as any).future).toBe('second');
  expect(await decryptString(body.login!.uris![1]!.uri!, key)).toBe('https://changed.test');
  // SHA-256 base64 checksum is the official Bitwarden representation.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('https://changed.test'));
  expect(await decryptString(body.login!.uris![1]!.uriChecksum!, key)).toBe(Buffer.from(hash).toString('base64'));
});

it('retains native encrypted passkeys unchanged and does not resurrect removed credentials/history', async () => {
  const native: Record<string, string> = { creationDate: '2026-01-01', future: 'opaque' };
  for (const [field, value] of Object.entries({ credentialId: 'credential-one', keyValue: 'private-key', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', rpId: 'example.test', counter: '1', discoverable: 'true' })) {
    native[field] = await encryptString(value, key);
  }
  const history = { password: await encryptString('old-password', key), lastUsedDate: '2026-01-01', future: 'keep' };
  const item = await decryptCipher(await fixture({ login: { fido2Credentials: [native] }, passwordHistory: [history] }), key);
  expect(item.login!.fido2Credentials[0]!.credentialId).toBe('credential-one');
  expect(item.login!.fido2Credentials[0]!.rpId).toBe('example.test');
  expect((await encryptCipher(item, key, {})).login!.fido2Credentials).toEqual([native]);
  expect((await encryptCipher(item, key, {})).passwordHistory).toEqual([history]);
  item.login!.fido2Credentials = [];
  item.passwordHistory = [];
  const body = await encryptCipher(item, key, {});
  expect(body.login!.fido2Credentials).toEqual([]);
  expect(body.passwordHistory).toBeNull();
});

it('rejects corrupt native passkey metadata instead of treating ciphertext as a credential ID', async () => {
  const item = await decryptCipher(await fixture({ login: { fido2Credentials: [{ credentialId: '2.broken', keyValue: 'legacy-private-key' }] } }), key);
  expect(item.login!.fido2Credentials).toEqual([]);
  await expect(encryptCipher(item, key, {})).rejects.toThrow(/无法解密|读取/);
});

it('rejects edits to unsupported custom types while allowing unrelated edits', async () => {
  const item = await decryptCipher(await fixture({ fields: [{ name: await encryptString('name', key), value: await encryptString('value', key), type: 88 }] }), key);
  item.name = 'new name';
  expect((await encryptCipher(item, key, {})).fields![0]!.type).toBe(88);
  item.customFields[0]!.value = 'modified';
  await expect(encryptCipher(item, key, {})).rejects.toThrow(/不支持编辑/);
});

it('preserves unknown identity properties when a supported identity field changes', async () => {
  const item = await decryptCipher(await fixture({ type: 4, login: null, identity: { firstName: await encryptString('Before', key), future: 'opaque-encrypted-data' } }), key);
  item.identity!.firstName = 'After';
  const body = await encryptCipher(item, key, {});
  expect((body.identity as any).future).toBe('opaque-encrypted-data');
  expect(await decryptString((body.identity as any).firstName, key)).toBe('After');
});

it('restores owner-only metadata and ignores forged draft ownership', async () => {
  const { retainItemMetadata } = await import('./preservation');
  const current = await decryptCipher(await fixture(), key);
  const draft = structuredClone(current);
  delete draft.preservation;
  draft.wrappedKey = 'forged';
  draft.updatedAt = 'forged';
  draft.name = 'Edited';
  draft.login!.autofillOnPageLoad = false;
  const merged = retainItemMetadata(current, draft);
  expect(merged.wrappedKey).toBeNull();
  expect(merged.updatedAt).toBe('2026-01-02');
  expect((await encryptCipher(merged, key, {})).organizationId).toBe('org1');
  expect(merged.login!.autofillOnPageLoad).toBe(false);
  expect(merged.name).toBe('Edited');
});

it('rejects a stale row identity instead of assigning another row its metadata', async () => {
  const { retainItemMetadata } = await import('./preservation');
  const dto = await fixture();
  const draft = await decryptCipher(dto, key);
  const latestDto = structuredClone(dto);
  latestDto.login!.uris!.splice(0, 1);
  const latest = await decryptCipher(latestDto, key);
  await expect(encryptCipher(retainItemMetadata(latest, draft), key, {})).rejects.toThrow(/已变化/);
});

it('can save an open draft after an unrelated resource update without changing row identities', async () => {
  const { retainItemMetadata } = await import('./preservation');
  const dto = await fixture();
  const draft = await decryptCipher(dto, key);
  draft.name = 'Open draft';
  const latest = await decryptCipher({ ...dto, revisionDate: 'newer', passwordHistory: [] }, key);
  const body = await encryptCipher(retainItemMetadata(latest, draft), key, {});
  expect(await decryptString(body.name, key)).toBe('Open draft');
});

it('retains unsupported passkey algorithm metadata when only its counter changes', async () => {
  const raw = { credentialId: 'credential', keyValue: 'private', rpId: 'test', keyAlgorithm: 'FUTURE', keyCurve: 'future-curve', counter: '1' };
  const item = await decryptCipher(await fixture({ login: { fido2Credentials: [raw] } }), key);
  item.login!.fido2Credentials[0]!.counter = '2';
  const row = (await encryptCipher(item, key, {})).login!.fido2Credentials![0]!;
  expect(row.keyAlgorithm).toBe('FUTURE');
  expect(row.keyCurve).toBe('future-curve');
  expect(await decryptString(row.counter!, key)).toBe('2');
});

it.each([null, undefined])('blocks renaming when a history row has a %s password instead of dropping the following valid row', async (password) => {
  const history = [
    { password, lastUsedDate: '2026-01-01' },
    { password: await encryptString('still-needed-history', key), lastUsedDate: '2026-01-02' },
  ];
  const item = await decryptCipher(await fixture({ passwordHistory: history }), key);
  expect(item.passwordHistory.map((row) => row.password)).toEqual(['still-needed-history']);
  item.name = 'Ordinary rename';
  await expect(encryptCipher(item, key, {})).rejects.toThrow(/无法解密|读取/);
  expect(item.preservation!.source.passwordHistory).toEqual(history);
});

it.each(['history', 'custom', 'uri', 'passkey'] as const)('blocks saving a %s list containing a nested array instead of a native record', async (kind) => {
  const data = kind === 'history' ? { passwordHistory: [[]] }
    : kind === 'custom' ? { fields: [[]] }
    : kind === 'uri' ? { login: { uris: [[]] } }
    : { login: { fido2Credentials: [[]] } };
  const item = await decryptCipher(await fixture(data), key);
  await expect(encryptCipher({ ...item, name: 'Rename' }, key, {})).rejects.toThrow(/无法解密|读取/);
});

it.each(['history', 'custom', 'uri', 'passkey'] as const)('blocks %s array compaction after a non-object entry followed by a valid row', async (kind) => {
  const encrypted = await encryptString('valid', key);
  const data = kind === 'history' ? { passwordHistory: [null, { password: encrypted, lastUsedDate: '2026-01-01' }] }
    : kind === 'custom' ? { fields: [7, { name: encrypted, value: encrypted, type: 0 }] }
    : kind === 'uri' ? { login: { uris: [null, { uri: encrypted, match: null }] } }
    : { login: { fido2Credentials: [false, { credentialId: 'valid-id', keyValue: 'private', rpId: 'valid.test' }] } };
  const item = await decryptCipher(await fixture(data), key);
  await expect(encryptCipher({ ...item, name: 'Rename' }, key, {})).rejects.toThrow(/无法解密|读取/);
});

it('keeps valid empty history passwords while rejecting missing passwords', async () => {
  const history = [{ password: '', lastUsedDate: '2026-01-01' },
    { password: await encryptString('', key), lastUsedDate: '2026-01-02' }];
  const item = await decryptCipher(await fixture({ passwordHistory: history }), key);
  expect(item.passwordHistory.map((row) => row.password)).toEqual(['', '']);
  expect((await encryptCipher({ ...item, name: 'Rename' }, key, {})).passwordHistory).toEqual(history);
});
