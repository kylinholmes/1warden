import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SORT_BY, emptyIdentity, emptyBankAccount, emptyDriversLicense, emptyPassport, emptyCard, type VaultItem } from '@1warden/vault';
import type { ItemSummary } from '@1warden/ui';
import type { ApplicationClient, ItemDetailData } from '../application/types';
import { EMPTY_SNAPSHOT } from '../application/types';
import { visibleVaultItems, type VaultCategory } from './vault-presentation';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { itemDetail } from '../application/service';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useSyncExternalStore: (subscribe: () => () => void, get: () => unknown) => react.useSyncExternalStore(subscribe, get, get) };
});

import { ItemDetail } from './VaultView';
import { Settings } from './Settings';

const client = {
  capabilities: { native: false, browser: true, saveAttachments: true },
  getSnapshot: () => EMPTY_SNAPSHOT,
} as ApplicationClient;

const item: ItemDetailData = {
  summary: {
    id: 'login', name: 'Example account', nameFailed: false, username: 'reader',
    hasPassword: true, hasTotp: false, uris: [], favorite: false, folderId: null,
    createdAt: '', updatedAt: '', type: 'login', summary: 'reader',
    iconDomain: null, avatarText: 'E', avatarHue: 42,
  },
  rawType: 1, notes: null, notesFailed: false,
  login: { username: 'reader', uris: [], hasPassword: true, hasTotp: false },
  card: null, identity: null, sshKey: null, customFields: [],
  passwordHistory: [{ lastUsedDate: '2026-01-01' }], attachments: [],
};

const summaries: ItemSummary[] = [
  { ...item.summary, id: 'delta', name: 'Delta', updatedAt: '2026-03-01', createdAt: '2026-04-01', favorite: true, folderId: 'main' },
  { ...item.summary, id: 'charlie', name: 'Charlie', updatedAt: '2026-02-01', createdAt: '2026-01-01', favorite: true, folderId: 'other' },
  { ...item.summary, id: 'alpha', name: 'Alpha', updatedAt: '2026-04-01', createdAt: '2026-02-01', favorite: true, folderId: 'main', type: 'card' },
  { ...item.summary, id: 'beta', name: 'Beta', updatedAt: '2026-01-01', createdAt: '2026-03-01', folderId: 'main' },
];
const siteMatches = ['beta', 'charlie', 'no-longer-in-vault'];

function renderNativeDetail(overrides: Partial<VaultItem>, displayClient = client): string {
  const detail = itemDetail({ ...blankEditorItem(), id: 'synthetic-document', name: 'Synthetic document', login: null, ...overrides });
  return renderToStaticMarkup(createElement(ItemDetail, {
    client: displayClient, item: detail, icons: null, onBack() {}, onEdit() {}, onDelete() {}, onToggleFavorite() {},
  }));
}

describe('current-site list priority', () => {
  it.each([
    [SORT_BY.name, ['beta', 'charlie', 'alpha', 'delta']],
    [SORT_BY.updated, ['charlie', 'beta', 'alpha', 'delta']],
    [SORT_BY.created, ['beta', 'charlie', 'delta', 'alpha']],
  ])('puts matches first and keeps %s order within both groups', (sort, expected) => {
    const before = summaries.slice();
    const visible = visibleVaultItems(summaries, { kind: 'all' }, sort, siteMatches);
    expect(visible.map((entry) => entry.id)).toEqual(expected);
    expect(summaries).toEqual(before);
  });

  it.each<{ category: VaultCategory; expected: string[] }>([
    { category: { kind: 'favorites' }, expected: ['charlie', 'alpha', 'delta'] },
    { category: { kind: 'folder', id: 'main' }, expected: ['beta', 'alpha', 'delta'] },
    { category: { kind: 'type', type: 'login' }, expected: ['beta', 'charlie', 'delta'] },
    { category: { kind: 'site' }, expected: ['beta', 'charlie'] },
  ])('keeps the $category.kind filter when prioritizing site matches', ({ category, expected }) => {
    expect(visibleVaultItems(summaries, category, SORT_BY.name, siteMatches).map((entry) => entry.id)).toEqual(expected);
  });

  it('only prioritizes matches that are in the current search results', () => {
    const searchResults = [summaries[2]!, summaries[1]!];
    expect(visibleVaultItems(searchResults, { kind: 'all' }, SORT_BY.name, siteMatches).map((entry) => entry.id))
      .toEqual(['charlie', 'alpha']);
    expect(visibleVaultItems([], { kind: 'all' }, SORT_BY.name, siteMatches)).toEqual([]);
  });

  it('keeps the normal desktop order without current-site matches', () => {
    expect(visibleVaultItems(summaries, { kind: 'all' }, SORT_BY.updated).map((entry) => entry.id))
      .toEqual(['alpha', 'delta', 'charlie', 'beta']);
    expect(visibleVaultItems(summaries, { kind: 'all' }, SORT_BY.updated, []).map((entry) => entry.id))
      .toEqual(['alpha', 'delta', 'charlie', 'beta']);
    expect(visibleVaultItems(summaries, { kind: 'site' }, SORT_BY.updated)).toEqual([]);
  });

  it('preserves input order when items in the same group have equal sort values', () => {
    const tied = summaries.map((entry) => ({ ...entry, updatedAt: '2026-01-01' }));
    expect(visibleVaultItems(tied, { kind: 'all' }, SORT_BY.updated, siteMatches).map((entry) => entry.id))
      .toEqual(['charlie', 'beta', 'delta', 'alpha']);
  });
});

describe('shared vault presentation', () => {
  it('renders a safe detail projection with reveal controls and a return action', () => {
    const html = renderToStaticMarkup(createElement(ItemDetail, {
      client, item, icons: null, onBack() {}, onEdit() {}, onDelete() {}, onToggleFavorite() {},
    }));
    expect(html).toContain('Example account');
    expect(html).toContain('reader');
    expect(html).toContain('aria-label="返回列表"');
    // Password history is collapsed by default and has no mounted secret fields.
    expect(html.match(/aria-label="显示"/g)).toHaveLength(1);
    expect(html).toContain('历史密码');
    expect(html).not.toContain('清空历史密码');
    expect(html).not.toContain('输入到其他应用');
    expect(html.indexOf('data-login-passkeys')).toBeLessThan(html.indexOf('data-item-resources'));
    expect(html.slice(html.indexOf('data-resource-actions'))).not.toContain('添加通行密钥');
  });

  it('keeps passkey-only credentials in the login section without a separate management entrance', () => {
    const passkeyOnly: ItemDetailData = { ...item, login: { username: null, uris: [], hasPassword: false, hasTotp: false,
      passkeys: [{ credentialId: 'synthetic-credential', rpId: 'example.com', rpName: 'Example',
        userName: 'reader', userDisplayName: null, creationDate: '2026-01-01' }] } };
    const html = renderToStaticMarkup(createElement(ItemDetail, {
      client, item: passkeyOnly, icons: null, onBack() {}, onEdit() {}, onDelete() {}, onToggleFavorite() {},
    }));
    expect(html).toMatch(/<h3[^>]*>登录<\/h3>/);
    expect(html).toContain('已保存 1 个');
    expect(html).toContain('删除通行密钥 Example');
    expect(html).not.toMatch(/<h3[^>]*>通行密钥<\/h3>/);
    expect(html.match(/aria-label="前往网站添加通行密钥"/g)).toHaveLength(1);
  });

  it('omits empty detail groups and puts folder organization after content', () => {
    const empty: ItemDetailData = { ...item, login: { username: '', uris: [{ uri: '', match: null }], hasPassword: false, hasTotp: false },
      passwordHistory: [], customFields: [], attachments: [] };
    const html = renderToStaticMarkup(createElement(ItemDetail, {
      client, item: empty, icons: null, onBack() {}, onEdit() {}, onDelete() {}, onToggleFavorite() {},
    }));
    expect(html).not.toMatch(/<h3[^>]*>登录<\/h3>/);
    expect(html).not.toMatch(/<h3[^>]*>网址<\/h3>/);
    expect(html).not.toMatch(/<h3[^>]*>附件<\/h3>/);
    expect(html).not.toMatch(/<h3[^>]*>通行密钥<\/h3>/);
    expect(html).toContain('条目管理');
    expect(html).not.toContain('更多操作');
    expect(html).not.toContain('新建文件夹');
    expect(html.indexOf('data-folder-organization')).toBeGreaterThan(html.indexOf('data-resource-actions'));
  });

  it('shows explicit false fields, a year-only expiry, and unreadable-data warnings', () => {
    const card: ItemDetailData = { ...item, summary: { ...item.summary, type: 'card' }, rawType: 3,
      login: null, passwordHistory: [], decryptionFailed: true,
      card: { cardholderName: null, brand: null, expMonth: null, expYear: '2030', hasNumber: false, hasCode: false },
      customFields: [{ name: 'Switch', type: 2, linkedId: null, value: 'false' }] };
    const html = renderToStaticMarkup(createElement(ItemDetail, {
      client, item: card, icons: null, onBack() {}, onEdit() {}, onDelete() {}, onToggleFavorite() {},
    }));
    expect(html).toContain('关闭');
    expect(html).toContain('2030');
    expect(html).toContain('部分字段无法读取或解密');
  });

  it('describes browser autofill without desktop permissions or quick panel shortcuts', () => {
    const html = renderToStaticMarkup(createElement(Settings, {
      open: true, account: '', serverUrl: '', onClose() {}, initialSection: 'autofill',
      capabilities: client.capabilities,
    }));
    expect(html).toContain('填充到当前页面');
    expect(html).not.toContain('辅助功能权限');
    expect(html).not.toContain('快速面板快捷键');
    expect(html).not.toContain('未连接');
  });
});

describe('shared compound-field presentation in record details', () => {
  it('uses the editor identity groups and surname/given-name/province/city order without duplicate visible group labels', () => {
    const html = renderNativeDetail({ type: 'identity', rawType: 4, notes: 'One notes section',
      identity: { ...emptyIdentity(), title: 'Mx', firstName: 'Given-name-marker', middleName: 'Middle-name-marker',
        lastName: 'Surname-marker', state: 'Province-marker', city: 'City-marker', ssn: 'Identity-id-marker' } });
    expect(html.match(/data-compound-field="[^"]+"/g)).toEqual([
      'data-compound-field="identity.name"', 'data-compound-field="identity.region"',
    ]);
    expect(html.indexOf('Surname-marker')).toBeLessThan(html.indexOf('Given-name-marker'));
    expect(html.indexOf('Given-name-marker')).toBeLessThan(html.indexOf('Middle-name-marker'));
    expect(html.indexOf('Province-marker')).toBeLessThan(html.indexOf('City-marker'));
    const headings = ['姓名与联系信息', '地址', '证件信息'].map(title => html.indexOf(`>${title}</h3>`));
    expect(headings.every(index => index >= 0)).toBe(true);
    expect(headings[0]).toBeLessThan(headings[1]!);
    expect(headings[1]).toBeLessThan(headings[2]!);
    expect(html).not.toMatch(/<span[^>]*>姓名<\/span>/);
    expect(html).not.toMatch(/<span[^>]*>地区<\/span>/);
    expect(html.match(/<h3[^>]*>备注<\/h3>/g)).toHaveLength(1);
  });

  it.each([
    ['driversLicense', 7, { driversLicense: { ...emptyDriversLicense(),
      firstName: 'Given-name-marker', middleName: 'Middle-name-marker', lastName: 'Surname-marker' } },
      ['Surname-marker', 'Given-name-marker', 'Middle-name-marker']],
    ['passport', 8, { passport: { ...emptyPassport(), surname: 'Surname-marker', givenName: 'Given-name-marker' } },
      ['Surname-marker', 'Given-name-marker']],
  ] as const)('renders the %s name as one shared compound row with each native value in order', (type, rawType, fields, values) => {
    const html = renderNativeDetail({ type, rawType, ...fields });
    expect(html.match(/data-compound-field="[^"]+"/g)).toEqual([`data-compound-field="${type}.name"`]);
    expect(html).toContain('aria-label="姓名"');
    values.forEach((value, index) => {
      expect(html).toContain(value);
      if (index > 0) expect(html.indexOf(values[index - 1]!)).toBeLessThan(html.indexOf(value));
    });
    expect(html.match(/data-field-layout="inline"/g)).toHaveLength(values.length);
    expect(html).toMatch(/data-field-label="true" class="[^"]*text-xs[^"]*">姓氏<\/span>/);
    expect(html).toMatch(/data-field-label="true" class="[^"]*text-xs[^"]*">名字<\/span>/);
    expect(html).not.toContain('w-[76px]');
    expect(html).not.toContain('col-span-2');
    expect(html).not.toMatch(/<span[^>]*>姓名<\/span>/);
  });

  it('hides missing compound children while keeping populated fields in the same single column', () => {
    const html = renderNativeDetail({ type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), lastName: 'Only-surname', firstName: '', middleName: null,
        state: '', city: 'Only-city' } });
    expect(html).toContain('data-compound-field="identity.name"');
    expect(html).toContain('data-compound-field="identity.region"');
    expect(html).toContain('Only-surname');
    expect(html).toContain('Only-city');
    expect(html).not.toMatch(/data-field-label="true"[^>]*>名字<\/span>/);
    expect(html).not.toMatch(/data-field-label="true"[^>]*>中间名<\/span>/);
    expect(html).not.toMatch(/data-field-label="true"[^>]*>省 \/ 州<\/span>/);
    expect(html).not.toContain('grid-template-columns');
    expect(html.match(/data-field-value="true"/g)).toHaveLength(2);
    expect(html.match(/data-field-layout="inline"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<h3[^>]*>证件信息<\/h3>/);
  });

  it.each([
    ['identity', 4, { identity: emptyIdentity() }],
    ['bankAccount', 6, { bankAccount: emptyBankAccount() }],
    ['driversLicense', 7, { driversLicense: emptyDriversLicense() }],
    ['passport', 8, { passport: emptyPassport() }],
  ] as const)('does not leave an empty compound or content section for an empty %s record', (type, rawType, fields) => {
    const html = renderNativeDetail({ type, rawType, ...fields });
    expect(html).not.toContain('data-compound-field=');
    expect(html).not.toMatch(/<h3[^>]*>(姓名与联系信息|地址|证件信息|银行账户|驾照|护照)<\/h3>/);
  });

  it('hides an entirely empty compound even when another field keeps its section visible', () => {
    const html = renderNativeDetail({ type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), company: 'Company-marker', country: 'Country-marker' } });
    expect(html).not.toContain('data-compound-field=');
    expect(html).toMatch(/<h3[^>]*>姓名与联系信息<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>地址<\/h3>/);
    expect(html).toContain('Company-marker');
    expect(html).toContain('Country-marker');
  });

  it('keeps long compound values wrap-capable and omits blank-only name cells', () => {
    const longName = 'LongSurname'.repeat(18);
    const longCity = 'LongCity'.repeat(24);
    const html = renderNativeDetail({ type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), lastName: longName, firstName: '   ', city: longCity } });
    expect(html).toContain(longName);
    expect(html).toContain(longCity);
    expect(html).toContain('whitespace-pre-wrap break-words [overflow-wrap:anywhere]');
    expect(html).not.toContain('title="   "');
    expect(html.match(/data-field-layout="inline"/g)).toHaveLength(2);
  });

  it('formats calendar dates and complete card expiry for display while preserving legacy values', () => {
    const document = { type: 'passport' as const, rawType: 8,
      passport: { ...emptyPassport(), givenName: 'Date-holder', dateOfBirth: '2000-01-02',
        issueDate: '2026-10-09', expirationDate: '12/2030' } };
    const original = structuredClone(document);
    const html = renderNativeDetail(document);
    expect(html).toContain('2000/01/02');
    expect(html).toContain('2026/10/09');
    expect(html).toContain('12/2030');
    expect(document).toEqual(original);
    const card = renderNativeDetail({ type: 'card', rawType: 3, card: { ...emptyCard(), expMonth: '2', expYear: '2030' } });
    expect(card).toContain('02/30');
    const partial = renderNativeDetail({ type: 'card', rawType: 3, card: { ...emptyCard(), expYear: '2030' } });
    expect(partial).toContain('—/2030');
  });

  it.each([
    ['bankAccount', 6, { bankAccount: { ...emptyBankAccount(), accountNumber: 'account-private-marker',
      pin: 'pin-private-marker', iban: 'iban-private-marker' } }, 3],
    ['driversLicense', 7, { driversLicense: { ...emptyDriversLicense(), licenseNumber: 'license-private-marker' } }, 1],
    ['passport', 8, { passport: { ...emptyPassport(), passportNumber: 'passport-private-marker',
      nationalIdentificationNumber: 'national-id-private-marker' } }, 2],
  ] as const)('keeps %s secret-only sections masked with the same explicit reveal controls', (type, rawType, fields, count) => {
    const reveal = vi.fn(async () => 'revealed-only-after-action');
    const html = renderNativeDetail({ type, rawType, ...fields }, { ...client, reveal });
    expect(html.match(/aria-label="显示"/g)).toHaveLength(count);
    expect(html).not.toContain('private-marker');
    expect(html).not.toContain('revealed-only-after-action');
    expect(html).not.toContain('data-compound-field=');
    expect(reveal).not.toHaveBeenCalled();
  });
});
