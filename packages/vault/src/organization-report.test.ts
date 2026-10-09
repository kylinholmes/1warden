import { describe, expect, it } from 'vitest';
import { emptyLogin, type VaultItem } from './model';
import { buildProfileItem } from './profile';
import { buildOrganizationReport } from './organization-report';

function item(id: string, change: Partial<VaultItem> = {}): VaultItem {
  return { id, name: 'Example account', type: 'login', rawType: 1, nameFailed: false, notes: 'private memo', notesFailed: false,
    folderId: null, favorite: false, reprompt: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username: 'Alice', password: 'private-password', totp: 'private-totp',
      uris: [{ uri: 'https://login.example.com/account', match: 3 }] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [], ...change };
}
function login(id: string, change: Partial<NonNullable<VaultItem['login']>>) { const i = item(id); i.login = { ...i.login!, ...change }; return i; }
function opaque(i: VaultItem, source: object) {
  i.preservation = { source: source as never, baseline: structuredClone(i), failures: [] }; return i;
}
describe('local organization report', () => {
  it('compares full known login content while ignoring record identity and timestamps', () => {
    const a = item('a'); const b = item('b', { createdAt: '2020-01-01', updatedAt: '2020-01-02', wrappedKey: 'other-wrapping-key' });
    const before = structuredClone([a, b]);
    expect(buildOrganizationReport([a, b]).duplicates).toEqual([{ kind: 'identical', itemIds: ['a', 'b'], reason: 'checkedContentMatches' }]);
    expect([a, b]).toEqual(before);
    const wire = JSON.stringify(buildOrganizationReport([a, b]));
    for (const secret of ['private-password', 'private-totp', 'private memo', 'other-wrapping-key', 'Alice', 'login.example.com']) expect(wire).not.toContain(secret);
  });
  it.each(['password', 'totp', 'username'] as const)('does not fold or trim credential %s during content comparison', field => {
    const a = item('a'); const b = login('b', { [field]: `${a.login![field]} ` });
    expect(buildOrganizationReport([a, b]).duplicates.every(group => group.kind !== 'identical')).toBe(true);
  });
  it('compares notes, URI matching, hidden custom fields, and organization metadata', () => {
    const a = item('a'); const b = item('b', { notes: 'different memo' });
    const c = login('c', { uris: [{ uri: a.login!.uris[0]!.uri, match: 5 }] });
    const d = item('d', { customFields: [{ name: 'hidden', value: 'secret-value', type: 1, linkedId: null }] });
    const e = item('e', { folderId: 'work-folder' });
    expect(buildOrganizationReport([a, b, c, d, e]).duplicates).toEqual([
      { kind: 'similar', itemIds: ['a', 'b', 'c', 'd', 'e'], reason: 'sameUsernameAndHost' },
    ]);
  });
  it('never repeats a record in equal and suspected groups', () => {
    const report = buildOrganizationReport([item('a'), item('b'), login('c', { password: 'different' })]);
    expect(report.duplicates).toEqual([{ kind: 'similar', itemIds: ['a', 'b', 'c'], reason: 'sameUsernameAndHost' }]);
    const ids = report.duplicates.flatMap(group => group.itemIds); expect(new Set(ids).size).toBe(ids.length);
  });
  it.each(['attachments', 'passwordHistory', 'passkeys', 'unknownSource', 'unknownLogin', 'unknownUri', 'legacyAlias', 'unknownField', 'unsupportedField', 'organization'] as const)
    ('keeps records with %s out of the stronger equivalence category', feature => {
      const a = item('a'); const b = item('b');
      if (feature === 'attachments') b.attachments = [{ id: 'file', fileName: 'private', size: '1', sizeName: '1 B', url: 'signed', key: 'attachment-secret', failed: false }];
      if (feature === 'passwordHistory') b.passwordHistory = [{ lastUsedDate: '', password: 'old-secret' }];
      if (feature === 'passkeys') b.login!.fido2Credentials = [{ credentialId: 'id', keyValue: 'private-key' } as never];
      if (feature === 'unknownSource') opaque(b, { extraEncryptedData: 'opaque-secret' });
      if (feature === 'unknownLogin') opaque(b, { login: { unknownCredential: 'opaque-secret' } });
      if (feature === 'unknownUri') opaque(b, { login: { uris: [{ uri: 'encrypted', match: 3, extra: 'opaque-secret' }] } });
      if (feature === 'legacyAlias') opaque(b, { login: { uri: 'opaque-legacy-url', uris: [{ uri: 'different-encrypted-url', match: 3 }] } });
      if (feature === 'unknownField') opaque(b, { fields: [{ name: null, value: null, type: 1, extra: 'opaque-secret' }] });
      if (feature === 'unsupportedField') b.customFields = [{ name: 'future', value: '', type: 0, linkedId: null, unsupportedType: 99 }];
      if (feature === 'organization') opaque(b, { organizationId: 'shared' });
      expect(buildOrganizationReport([a, b]).duplicates).toEqual([{ kind: 'similar', itemIds: ['a', 'b'], reason: 'sameUsernameAndHost' }]);
    });
  it('still compares fully decoded ordinary records that have preservation state', () => {
    const source = { organizationId: null, login: { username: 'encrypted', password: 'encrypted', uris: [{ uri: 'encrypted', match: 3 }] } };
    expect(buildOrganizationReport([opaque(item('a'), source), opaque(item('b'), source)]).duplicates[0]?.kind).toBe('identical');
  });
  it('uses exact usernames and full canonical hosts including subdomains and ports', () => {
    const report = buildOrganizationReport([
      login('a', { uris: [{ uri: 'HTTPS://LOGIN.EXAMPLE.COM:443/one', match: null }], password: 'one' }),
      login('b', { uris: [{ uri: 'login.example.com/two', match: 1 }], password: 'two' }),
      login('different-user', { username: 'alice' }),
      login('other-service', { uris: [{ uri: 'https://mail.example.com', match: 0 }] }),
      login('other-port', { uris: [{ uri: 'https://login.example.com:8443', match: 0 }] }),
      login('regex', { uris: [{ uri: 'https://login.example.com', match: 4 }] }),
      login('native', { uris: [{ uri: 'androidapp://login.example.com', match: null }] }),
    ]);
    expect(report.duplicates).toEqual([{ kind: 'similar', itemIds: ['a', 'b'], reason: 'sameUsernameAndHost' }]);
  });
  it('does not conflate private suffix tenants or malformed and credential-bearing URLs', () => {
    const uris = ['https://alice.github.io', 'https://bob.github.io', 'https://user:secret@alice.github.io', 'http://[', 'androidapp://com.example'];
    const report = buildOrganizationReport(uris.map((uri, n) => login(String(n), { uris: [{ uri, match: null }] })));
    expect(report.duplicates).toEqual([]);
    expect(report.missingUrls).toEqual([]);
  });
  it('does not declare a preserved but undecoded legacy URL absent', () => {
    const legacy = opaque(login('legacy', { uris: [] }), { login: { uri: 'opaque-encrypted-url', uris: [] } });
    const absent = opaque(login('absent', { uris: [] }), { login: { uri: null, uris: [] } });
    const empty = opaque(login('empty', { uris: [] }), { login: { uri: '', uris: [] } });
    expect(buildOrganizationReport([legacy, absent, empty]).missingUrls).toEqual(['absent', 'empty']);
  });
  it('finds a shared host in multiple URLs while showing each connected record only once', () => {
    const a = login('a', { uris: [{ uri: 'https://one.example', match: 0 }] });
    const b = login('b', { uris: [{ uri: 'https://one.example', match: 0 }, { uri: 'https://two.example', match: 0 }] });
    const c = login('c', { uris: [{ uri: 'https://two.example', match: 0 }] });
    expect(buildOrganizationReport([a, b, c]).duplicates).toEqual([{ kind: 'similar', itemIds: ['a', 'b', 'c'], reason: 'sameUsernameAndHost' }]);
  });
  it('keeps non-login records out of login duplicate grouping and missing-field checks', () => {
    const note = item('note', { type: 'secureNote', rawType: 2, secureNote: { type: 0 }, login: null });
    const report = buildOrganizationReport([note, { ...note, id: 'second-note' }]);
    expect(report).toMatchObject({ checked: 2, duplicates: [], missingUrls: [], missingUsernames: [] });
  });
  it('skips attachment decryption failures instead of declaring a broken record incomplete or equal', () => {
    const broken = item('broken', { name: 'Untitled' });
    broken.attachments = [{ id: 'file', fileName: '', size: '1', sizeName: '1 B', url: '', key: null, failed: true }];
    expect(buildOrganizationReport([broken])).toEqual({ total: 1, checked: 0, skipped: 1, duplicates: [],
      missingUrls: [], missingUsernames: [], lowInformationNames: [], unfiled: [] });
  });
  it('flags narrow default titles and actual empty login fields without classifying short names as bad', () => {
    const cases = [item('default', { name: ' Untitled ' }), item('chinese', { name: '微信' }), item('numeric', { name: '123' }),
      item('domain', { name: 'example.com' }), item('empty', { name: '   ', login: { ...emptyLogin(), username: ' ', uris: [{ uri: ' ', match: null }] } }),
      item('note', { name: '笔记', type: 'secureNote', rawType: 2, login: null, secureNote: { type: 0 } })];
    const report = buildOrganizationReport(cases);
    expect(report.lowInformationNames).toEqual(['default', 'empty']);
    expect(report.missingUrls).toEqual(['empty']); expect(report.missingUsernames).toEqual(['empty']);
    expect(report.unfiled).toEqual(cases.map(value => value.id));
  });
  it('excludes deleted, archived and profile records, and reports unreadable or unknown records only as skipped', () => {
    const broken = item('broken', { name: '' }); broken.preservation = { failures: ['password decode failure'] } as never;
    const report = buildOrganizationReport([item('live'), item('trash', { deletedAt: '2026-01-01' }),
      item('archive', { archivedAt: '2026-01-01' }), { ...buildProfileItem({ displayName: 'Me', avatarDataUrl: null }), id: 'profile' },
      item('name-failed', { nameFailed: true }), item('notes-failed', { notesFailed: true }), broken,
      item('unknown', { type: 'unknown', rawType: 99 })]);
    expect(report).toMatchObject({ total: 5, checked: 1, skipped: 4, unfiled: ['live'], lowInformationNames: [], duplicates: [] });
  });
});
