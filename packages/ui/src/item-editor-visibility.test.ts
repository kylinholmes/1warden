import { describe, expect, it } from 'vitest';
import type { VaultItem } from '@1warden/vault';
import { availableNativeFields, blankEditorItem, clearNativeField, createCustomField, initialVisibleFields, nativeFieldValue, updateNativeField } from './item-editor-fields';

describe('sparse editor presentation and native edits', () => {
  it('shows populated saved fields without changing hidden empty/native/unknown data', () => {
    const item = blankEditorItem();
    item.login = { ...item.login!, username: 'alice', autofillOnPageLoad: false };
    item.notes = '';
    item.customFields = [{ name: 'empty but named', value: '', type: 0, linkedId: null }, { name: 'off', value: 'false', type: 2, linkedId: null }, { name: 'future', value: 'keep', type: 0, linkedId: null, unsupportedType: 99 }];
    const before = structuredClone(item);
    expect(initialVisibleFields(item, false)).toEqual(['login.username']);
    expect(item).toEqual(before);
    const changed = updateNativeField(item, 'login.username', 'bob');
    expect(changed.login).toEqual({ ...item.login, username: 'bob' });
    expect(changed.notes).toBe('');
    expect(changed.customFields).toBe(item.customFields);
  });
  it.each([
    ['login', ['login.username', 'login.password', 'login.uris']],
    ['card', ['card.number', 'card.expiry', 'card.code']],
    ['identity', ['identity.firstName', 'identity.lastName']],
    ['secureNote', ['notes']], ['sshKey', ['sshKey.privateKey']],
  ] as const)('starts %s with its minimal template', (type, expected) => {
    expect(initialVisibleFields({ ...blankEditorItem(), type }, true)).toEqual(expected);
  });
  it('excludes visible singletons but keeps websites repeatable and item types valid', () => {
    const item = blankEditorItem();
    const visible = ['login.username', 'login.password', 'login.uris'];
    const available = availableNativeFields(item.type, visible).map(field => field.id);
    expect(available).toEqual(['login.totp', 'login.uris', 'notes']);
    expect(availableNativeFields('sshKey', []).some(field => field.id.startsWith('login.'))).toBe(false);
  });
  it('clears optional native values for next open while keeping a caller visibility set stable', () => {
    const item = { ...blankEditorItem(), notes: 'memo' };
    const visible = initialVisibleFields(item, false);
    const cleared = updateNativeField(item, 'notes', '');
    expect(visible).toEqual(['notes']);
    expect(initialVisibleFields(cleared, false)).toEqual([]);
    expect(cleared.notes).toBe('');
  });
  it('native OTP edits preserve existing custom OTP rows and unsupported fields', () => {
    const item = blankEditorItem();
    item.customFields = [{ name: 'otp', value: 'old-custom-secret', type: 1, linkedId: null, sourceId: 'otp-source' },
      { name: 'OTP', value: 'future', type: 0, linkedId: null, unsupportedType: 99 }];
    expect(initialVisibleFields(item, false)).toEqual([]);
    const updated = updateNativeField(item, 'login.totp', 'native-secret');
    expect(updated.login?.totp).toBe('native-secret');
    expect(updated.customFields).toBe(item.customFields);
    expect(clearNativeField(updated, 'login.totp').customFields).toBe(item.customFields);
  });
  it('explicitly removes a combined expiry and leaves all unrelated card data intact', () => {
    const item: VaultItem = { ...blankEditorItem(), type: 'card', card: { cardholderName: null, brand: '', number: '1234', expMonth: '0', expYear: '2030', code: null } };
    expect(initialVisibleFields(item, false)).toEqual(['card.number', 'card.expiry']);
    expect(nativeFieldValue(item, 'card.expMonth')).toBe('0');
    const removed = clearNativeField(item, 'card.expiry');
    expect(removed.card).toEqual({ ...item.card, expMonth: null, expYear: null });
    expect(item.card?.expYear).toBe('2030');
  });
});

describe('Add More selects actual custom type before creating a row', () => {
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
