import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SORT_BY } from '@1warden/vault';
import type { ItemSummary } from '@1warden/ui';
import type { ApplicationClient, ItemDetailData } from '../application/types';
import { visibleVaultItems, type VaultCategory } from './vault-presentation';

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
    expect(html.match(/aria-label="显示"/g)).toHaveLength(2);
    expect(html).not.toContain('输入到其他应用');
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
