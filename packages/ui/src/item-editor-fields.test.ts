import { describe, expect, it } from 'vitest';
import { changeCustomFieldType, linkedFieldTargets, updateLoginUri, removeLoginUri, customFieldsForItemType, savedLoginUris } from './item-editor-fields';

describe('editor URL changes', () => {
  const first = { uri: 'https://one.example', match: 3, sourceId: 'one', metadata: { checksum: 'keep' } };
  const second = { uri: 'https://two.example', match: 5, sourceId: 'two', metadata: { checksum: 'also-keep' } };
  it('editing a URL retains other URLs, matching rules and entry metadata', () => {
    const result = updateLoginUri([first, second], 0, { uri: 'https://new.example' });
    expect(result).toEqual([{ ...first, uri: 'https://new.example' }, second]);
    expect(result[1]).toBe(second);
    expect(first.uri).toBe('https://one.example');
  });
  it('changing one match mode leaves the URL and other entries intact', () => {
    expect(updateLoginUri([first, second], 1, { match: null })).toEqual([first, { ...second, match: null }]);
  });
  it('clearing a URL keeps its input row editable and removes only that entry on save', () => {
    const cleared = updateLoginUri([first, second], 0, { uri: '' });
    expect(cleared).toEqual([{ ...first, uri: '' }, second]);
    expect(savedLoginUris(cleared, [first, second])).toEqual([second]);
    expect(savedLoginUris(updateLoginUri([first], 0, { uri: '' }), [first])).toEqual([]);
    expect(removeLoginUri([first, second], 1)).toEqual([first]);
  });
  it('drops only unused new URL rows on save and preserves preexisting empty rows', () => {
    const existingEmpty = { uri: '', match: 5, sourceId: 'saved-empty', metadata: { checksum: 'keep' } };
    expect(savedLoginUris([first, { uri: '', match: null }, existingEmpty], [first, existingEmpty])).toEqual([first, existingEmpty]);
    expect(savedLoginUris([{ uri: '', match: null }])).toEqual([]);
  });
});

describe('custom field transitions', () => {
  const text = { name: 'extra', value: 'secret', type: 0 as const, linkedId: null, sourceId: 'stable' };
  it('uses a valid target and clears the unrelated literal when creating a linked login field', () => {
    expect(changeCustomFieldType(text, 3, 'login')).toEqual({ ...text, type: 3, value: '', linkedId: 100 });
  });
  it('uses targets for the actual item type and refuses linked fields on notes and SSH keys', () => {
    expect(changeCustomFieldType(text, 3, 'card').linkedId).toBe(300);
    expect(changeCustomFieldType(text, 3, 'identity').linkedId).toBe(400);
    expect(changeCustomFieldType(text, 3, 'secureNote')).toBe(text);
    expect(linkedFieldTargets('sshKey')).toEqual([]);
    expect(linkedFieldTargets('login').map(x => x.id)).toEqual([100, 101]);
    expect(linkedFieldTargets('identity').find(x => x.id === 418)?.label).toBe('全名');
  });
  it('preserves unsupported preexisting linked targets until the user changes the type', () => {
    const unsupported = { ...text, type: 3 as const, value: '', linkedId: 999 };
    expect(changeCustomFieldType(unsupported, 3, 'login')).toBe(unsupported);
    expect(changeCustomFieldType(unsupported, 0, 'login')).toEqual({ ...unsupported, type: 0, linkedId: null });
  });
  it.each([['true', 'true'], ['false', 'false'], ['arbitrary', 'false'], ['', 'false']])('converting %s to boolean stores the native string %s', (value, expected) => {
    expect(changeCustomFieldType({ ...text, value }, 2, 'login')).toEqual({ ...text, value: expected, type: 2 });
  });
  it('leaving linked type clears its numeric target', () => {
    expect(changeCustomFieldType({ ...text, type: 3, linkedId: 101, value: '' }, 1, 'login')).toEqual({ ...text, type: 1, value: '' });
  });
  it('changing a new item type cannot leave newly created linked fields invalid', () => {
    const linked = { ...text, type: 3 as const, value: '', linkedId: 100 };
    expect(customFieldsForItemType([linked], 'card')).toEqual([{ ...linked, linkedId: 300 }]);
    expect(customFieldsForItemType([linked], 'sshKey')).toEqual([{ ...linked, type: 0, linkedId: null }]);
  });
});
