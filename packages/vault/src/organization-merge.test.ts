import { describe, expect, it } from 'vitest';
import { emptyLogin, type VaultItem } from './model';
import { mergeOrganizationItems, previewOrganizationMerge } from './organization-merge';

export function mergeFixtureItem(id: string): VaultItem {
  return { id, type: 'login', rawType: 1, name: 'Fixture Login', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', deletedAt: null, archivedAt: null,
    wrappedKey: null, login: { ...emptyLogin(), username: 'fixture-user', password: 'fixture-password',
      uris: [{ uri: 'https://fixture.invalid', match: null }] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
}

describe('organization merge planning', () => {
  it('does not reveal credentials, custom fields or notes in a preview', () => {
    const base = mergeFixtureItem('base'); const source = mergeFixtureItem('source');
    source.login!.password = 'private-password-two'; source.login!.totp = 'private-seed';
    base.login!.totp = 'private-seed-base'; source.notes = 'private-note';
    source.customFields = [{ name: 'private-name', value: 'private-value', type: 1, linkedId: null }];
    const preview = previewOrganizationMerge([base, source], [], 'opaque-token');
    expect(preview.fields.filter(field => field.secret).map(field => field.key)).toEqual(['password', 'totp']);
    expect(preview.fields.every(field => field.selectedItemId === null)).toBe(true);
    const serialized = JSON.stringify(preview);
    for (const value of ['fixture-password', 'private-password-two', 'private-seed', 'private-note', 'private-name', 'private-value']) expect(serialized).not.toContain(value);
  });

  it('requires explicit valid conflict choices and retains non-selected secrets', () => {
    const base = mergeFixtureItem('base'); const source = mergeFixtureItem('source');
    source.name = 'Other title'; source.login!.password = 'other-password';
    base.login!.totp = 'base-seed'; source.login!.totp = 'other-seed';
    expect(() => mergeOrganizationItems([base, source], {})).toThrow(/选择/);
    expect(() => mergeOrganizationItems([base, source], { name: 'base', password: 'other-id', totp: 'base' })).toThrow(/选择/);
    const merged = mergeOrganizationItems([base, source], { name: 'base', password: 'source', totp: 'base' });
    expect(merged.login!.password).toBe('other-password'); expect(merged.login!.totp).toBe('base-seed');
    expect(merged.passwordHistory.some(entry => entry.password === 'fixture-password')).toBe(true);
    expect(merged.customFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Other title', type: 1 }), expect.objectContaining({ value: 'other-seed', type: 1 }),
    ]));
    expect(base.customFields).toEqual([]); expect(base.login!.password).toBe('fixture-password');
  });

  it('fills missing fields, deduplicates exact rows and retains conflicting custom values and histories without a five-entry cap', () => {
    const base = mergeFixtureItem('base'); const source = mergeFixtureItem('source');
    base.login!.password = null; source.favorite = true; source.notes = 'source note'; base.notes = 'base note';
    base.customFields = [{ name: 'Code', value: 'base value', type: 1, linkedId: null }];
    source.customFields = [{ name: 'Code', value: 'source value', type: 1, linkedId: null, sourceId: 'field:foreign:0' }];
    source.login!.uris.push({ uri: 'https://another.invalid', match: 3, sourceId: 'uri:foreign:1' });
    source.passwordHistory = Array.from({ length: 7 }, (_, index) => ({ password: `old-${index}`, lastUsedDate: `2025-01-0${index + 1}`, sourceId: `history:foreign:${index}` }));
    const merged = mergeOrganizationItems([base, source], {});
    expect(merged.login!.password).toBe('fixture-password'); expect(merged.favorite).toBe(true);
    expect(merged.notes).toBe('base note\n\n---\n\nsource note'); expect(merged.login!.uris).toHaveLength(2);
    expect(merged.customFields).toHaveLength(2); expect(merged.passwordHistory).toHaveLength(7);
    expect(merged.customFields[1]!.sourceId).toBeUndefined(); expect(merged.login!.uris[1]!.sourceId).toBeUndefined();
    expect(merged.passwordHistory.every(row => row.sourceId === undefined)).toBe(true);
  });

  it.each(['attachment', 'passkey', 'reprompt', 'linked', 'unknown', 'organization', 'readOnly', 'decryption'] as const)('blocks unsafe %s records', kind => {
    const base = mergeFixtureItem('base'); const source = mergeFixtureItem('source');
    if (kind === 'attachment') source.attachments.push({ id: 'attachment', fileName: 'a.txt', size: '1', sizeName: '1 B', url: '', key: null, failed: false });
    if (kind === 'passkey') source.login!.fido2Credentials.push({ credentialId: 'fake' } as never);
    if (kind === 'reprompt') source.reprompt = 1;
    if (kind === 'linked') source.customFields.push({ name: 'linked', value: '', type: 3, linkedId: 101 });
    if (['unknown', 'organization', 'readOnly'].includes(kind)) source.preservation = { baseline: structuredClone(source), failures: [], source: {
      id: source.id, type: 1, name: '', ...(kind === 'unknown' ? { futureSecret: 'opaque' } : {}),
      ...(kind === 'organization' ? { organizationId: 'other-owner' } : {}), ...(kind === 'readOnly' ? { edit: false } : {}),
    } as never };
    if (kind === 'decryption') source.notesFailed = true;
    expect(previewOrganizationMerge([base, source], [], 'token').blockers.length).toBeGreaterThan(0);
    expect(() => mergeOrganizationItems([base, source], {})).toThrow();
  });
});
