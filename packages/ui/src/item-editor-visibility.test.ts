import { describe, expect, it } from 'vitest';
import type { VaultItem } from '@1warden/vault';
import { emptyBankAccount, emptyDriversLicense, emptyPassport } from '@1warden/vault';
import { blankCard, blankEditorItem, blankIdentity, blankSshKey, createCustomField, nativeEditorFields, nativeFieldValue, updateNativeField } from './item-editor-fields';

describe('complete native editor fields and native edits', () => {
  it('enumerates the full template without changing empty/native/unknown data', () => {
    const item = blankEditorItem();
    item.login = { ...item.login!, username: 'alice', autofillOnPageLoad: false };
    item.notes = '';
    item.customFields = [{ name: 'empty but named', value: '', type: 0, linkedId: null }, { name: 'off', value: 'false', type: 2, linkedId: null }, { name: 'future', value: 'keep', type: 0, linkedId: null, unsupportedType: 99 }];
    const before = structuredClone(item);
    expect(nativeEditorFields(item.type).map(field => field.id)).toEqual([
      'login.username', 'login.password', 'login.totp', 'login.uris', 'notes',
    ]);
    expect(item).toEqual(before);
    const changed = updateNativeField(item, 'login.username', 'bob');
    expect(changed.login).toEqual({ ...item.login, username: 'bob' });
    expect(changed.notes).toBe('');
    expect(changed.customFields).toBe(item.customFields);
  });
  it.each([
    ['login', ['username', 'password', 'totp', 'uris']],
    ['card', Object.keys(blankCard())], ['identity', Object.keys(blankIdentity())], ['secureNote', []],
    ['sshKey', Object.keys(blankSshKey())], ['bankAccount', Object.keys(emptyBankAccount())],
    ['driversLicense', Object.keys(emptyDriversLicense())], ['passport', Object.keys(emptyPassport())],
  ] as const)('provides every fixed %s field including notes', (type, nativeKeys) => {
    const fields = nativeEditorFields(type);
    const keys = fields.flatMap(field => [...field.keys]);
    const expected = [...nativeKeys.map(key => `${type}.${key}`), 'notes'];
    expect([...keys].sort()).toEqual(expected.sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(fields.at(-1)?.id).toBe('notes');
    expect(keys.every(key => key === 'notes' || key.startsWith(`${type}.`))).toBe(true);
  });
  it('keeps a cleared field in the full template for the next edit', () => {
    const item = { ...blankEditorItem(), notes: 'memo' };
    const fields = nativeEditorFields(item.type);
    const cleared = updateNativeField(item, 'notes', '');
    expect(nativeEditorFields(cleared.type)).toEqual(fields);
    expect(fields.some(field => field.id === 'notes')).toBe(true);
    expect(cleared.notes).toBe('');
  });
  it.each([
    ['identity', ['identity.lastName', 'identity.firstName', 'identity.middleName']],
    ['driversLicense', ['driversLicense.lastName', 'driversLicense.firstName', 'driversLicense.middleName']],
    ['passport', ['passport.surname', 'passport.givenName']],
  ] as const)('groups %s names visually while preserving separate native keys', (type, keys) => {
    const field = nativeEditorFields(type).find(field => field.id === `${type}.name`)!;
    expect(field.kind).toBe('compound');
    expect(field.keys).toEqual(keys);
    expect(field.labels).toHaveLength(keys.length);
    // Names remain separate native fields; their single-column presentation
    // must no longer carry old multi-column width hints.
    expect(field).not.toHaveProperty('minColumnWidth');
    const populated = field.keys.reduce<VaultItem>((draft, key, index) => updateNativeField(draft, key, `Part ${index}`), { ...blankEditorItem(), type });
    field.keys.forEach((key, index) => expect(nativeFieldValue(populated, key)).toBe(`Part ${index}`));
    expect(nativeFieldValue(populated, `${type}.name`)).toBeUndefined();
  });
  it('gives province and city separate keys without multi-column width hints', () => {
    const region = nativeEditorFields('identity').find(field => field.id === 'identity.region')!;
    expect(region.kind).toBe('compound');
    expect(region.keys).toEqual(['identity.state', 'identity.city']);
    expect(region.labels).toEqual(['省 / 州', '城市']);
    expect(region).not.toHaveProperty('minColumnWidth');
    const updated = updateNativeField(updateNativeField({ ...blankEditorItem(), type: 'identity' }, 'identity.state', 'Example State'), 'identity.city', 'Example City');
    expect(updated.identity?.state).toBe('Example State');
    expect(updated.identity?.city).toBe('Example City');
  });
  it.each(['driversLicense', 'passport'] as const)('uses date controls for native %s calendar fields', type => {
    for (const key of ['dateOfBirth', 'issueDate', 'expirationDate']) {
      expect(nativeEditorFields(type).find(field => field.id === `${type}.${key}`)?.kind).toBe('date');
    }
  });
  it('native OTP edits preserve existing custom OTP rows and unsupported fields', () => {
    const item = blankEditorItem();
    item.customFields = [{ name: 'otp', value: 'old-custom-secret', type: 1, linkedId: null, sourceId: 'otp-source' },
      { name: 'OTP', value: 'future', type: 0, linkedId: null, unsupportedType: 99 }];
    const updated = updateNativeField(item, 'login.totp', 'native-secret');
    expect(updated.login?.totp).toBe('native-secret');
    expect(updated.customFields).toBe(item.customFields);
    expect(updateNativeField(updated, 'login.totp', '').customFields).toBe(item.customFields);
  });
  it('edits expiry parts without changing the other part or unrelated card data', () => {
    const item: VaultItem = { ...blankEditorItem(), type: 'card', card: { cardholderName: null, brand: '', number: '1234', expMonth: '0', expYear: '2030', code: null } };
    expect(nativeEditorFields(item.type).find(field => field.id === 'card.expiry')?.keys).toEqual(['card.expMonth', 'card.expYear']);
    expect(nativeFieldValue(item, 'card.expMonth')).toBe('0');
    const changed = updateNativeField(item, 'card.expMonth', '');
    expect(changed.card).toEqual({ ...item.card, expMonth: '' });
    expect(item.card?.expYear).toBe('2030');
  });
  it.each([
    ['bankAccount', 'bankAccount.accountNumber', '001234567', 'bankAccount.bankName', 'Example Bank'],
    ['driversLicense', 'driversLicense.licenseNumber', 'DL-1234', 'driversLicense.expirationDate', '2030-12-01'],
    ['passport', 'passport.passportNumber', 'P0123456', 'passport.nationality', 'Example'],
  ] as const)('edits native %s fields and clears only the selected value', (type, secretKey, secret, otherKey, other) => {
    const item = { ...blankEditorItem(), type };
    const populated = updateNativeField(updateNativeField(item, secretKey, secret), otherKey, other);
    expect(nativeFieldValue(populated, secretKey)).toBe(secret);
    expect(nativeFieldValue(populated, otherKey)).toBe(other);
    expect(nativeEditorFields(type).find(field => field.id === secretKey)?.kind).toBe('secret');
    const cleared = updateNativeField(populated, secretKey, '');
    expect(nativeFieldValue(cleared, secretKey)).toBe('');
    expect(nativeFieldValue(cleared, otherKey)).toBe(other);
    expect(nativeFieldValue(populated, secretKey)).toBe(secret);
  });
  it('does not coerce native encrypted document dates or introduce custom field types', () => {
    const item = updateNativeField({ ...blankEditorItem(), type: 'passport' }, 'passport.expirationDate', '12/2030');
    expect(nativeFieldValue(item, 'passport.expirationDate')).toBe('12/2030');
    expect(nativeEditorFields('bankAccount').flatMap(field => [...field.keys])).toHaveLength(11);
    expect(nativeEditorFields('driversLicense').flatMap(field => [...field.keys])).toHaveLength(12);
    expect(nativeEditorFields('passport').flatMap(field => [...field.keys])).toHaveLength(14);
    expect(createCustomField(3, 'bankAccount')).toBeNull();
    expect(createCustomField(3, 'driversLicense')).toBeNull();
    expect(createCustomField(3, 'passport')).toBeNull();
  });
});

describe('custom-field picker selects actual type before creating a row', () => {
  it('creates hidden and boolean fields with their actual types including false', () => {
    expect(createCustomField(1, 'login')).toEqual({ name: '', value: '', type: 1, linkedId: null });
    expect(createCustomField(2, 'login')).toEqual({ name: '', value: 'false', type: 2, linkedId: null });
  });
  it('selects only a valid native linked target and refuses unsupported item types', () => {
    expect(createCustomField(3, 'card')).toEqual({ name: '', value: '', type: 3, linkedId: 300 });
    expect(createCustomField(3, 'secureNote')).toBeNull();
    expect(createCustomField(3, 'sshKey')).toBeNull();
  });
});
