import { describe, it, expect } from 'vitest';
import { searchItems, matchByDomain } from './search';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function item(over: Partial<VaultItem> & { id: string }): VaultItem {
  return {
    type: 'login', rawType: 1, nameFailed: false, notesFailed: false,
    notes: null, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: '2026-01-01T00:00:00.000000Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    name: '', login: emptyLogin(), card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

const ITEMS = [
  item({ id: '1', name: 'GitHub', login: { ...emptyLogin(), username: 'kylin', uris: [{ uri: 'https://github.com', match: null }] } }),
  item({ id: '2', name: 'GitHub Enterprise', login: { ...emptyLogin(), username: 'work' } }),
  item({ id: '3', name: 'GitLab', login: { ...emptyLogin(), username: 'kylin' } }),
  item({ id: '4', name: '银行', notes: '里面有 github 的备用账号' }),
];
const ids = (hits: { item: VaultItem }[]) => hits.map((h) => h.item.id);

describe('searchItems — 匹配', () => {
  it('matches by name, case-insensitively', () => {
    expect(ids(searchItems(ITEMS, [], 'GITHUB'))).toContain('1');
  });
  it('matches by username', () => {
    expect(ids(searchItems(ITEMS, [], 'kylin'))).toEqual(expect.arrayContaining(['1', '3']));
  });
  it('matches by URI', () => {
    expect(ids(searchItems(ITEMS, [], 'github.com'))).toContain('1');
  });
  it('matches by notes at lower priority', () => {
    expect(ids(searchItems(ITEMS, [], '备用账号'))).toContain('4');
  });
  it('matches Chinese', () => {
    expect(ids(searchItems(ITEMS, [], '银行'))).toContain('4');
  });
  it('returns nothing for a non-match', () => {
    expect(searchItems(ITEMS, [], 'zzzz-no-match')).toEqual([]);
  });
  it('honours the limit', () => {
    expect(searchItems(ITEMS, [], '', { limit: 2 })).toHaveLength(2);
  });
});

describe('searchItems — 排序', () => {
  // 用户敲 "github" 时想要的是 GitHub，不是 GitHub Enterprise
  it('ranks exact above prefix above substring', () => {
    const got = ids(searchItems(ITEMS, [], 'github'));
    expect(got[0]).toBe('1');
    expect(got.indexOf('1')).toBeLessThan(got.indexOf('2'));
  });
});

describe('searchItems — 浏览模式', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(searchItems(ITEMS, [], '')).toHaveLength(ITEMS.length);
    expect(searchItems(ITEMS, [], '   ')).toHaveLength(ITEMS.length);
  });

  it('puts favourites first in browse mode', () => {
    const withFav = [item({ id: 'a', name: 'A' }), item({ id: 'b', name: 'B', favorite: true })];
    expect(ids(searchItems(withFav, [], ''))[0]).toBe('b');
  });
});

describe('searchItems — 绝不返回已删除或已归档的条目', () => {
  // ⚠️ 服务端不帮我们过滤。不分区的话用户删掉的密码会一直出现在搜索结果里。
  it('excludes trashed and archived items from results', () => {
    const withDead = [
      ...ITEMS,
      item({ id: 'trashed', name: 'GitHub Old', deletedAt: '2026-03-01T00:00:00.000000Z' }),
      item({ id: 'archived', name: 'GitHub Archived', archivedAt: '2026-02-01T00:00:00.000000Z' }),
    ];
    const got = ids(searchItems(withDead, [], 'github'));
    expect(got).not.toContain('trashed');
    expect(got).not.toContain('archived');
    // 浏览模式下也不该出现
    expect(ids(searchItems(withDead, [], ''))).not.toContain('trashed');
  });
});

describe('searchItems — 健壮性', () => {
  it('survives an item whose name failed to decrypt', () => {
    const broken = [item({ id: 'broken', name: '', nameFailed: true })];
    expect(() => searchItems(broken, [], 'anything')).not.toThrow();
  });

  it('matches by folder name', () => {
    const withFolder = [item({ id: 'f', name: 'X', folderId: 'f1' })];
    const folders = [{ id: 'f1', name: '工作', nameFailed: false, updatedAt: 'x' }];
    expect(ids(searchItems(withFolder, folders, '工作'))).toContain('f');
  });

  it('matches by custom field value', () => {
    const withField = [item({ id: 'cf', name: 'X', customFields: [{ name: '备注', value: 'secret-tag', type: 0, linkedId: null }] })];
    expect(ids(searchItems(withField, [], 'secret-tag'))).toContain('cf');
  });
});

describe('matchByDomain', () => {
  const items = [
    item({ id: 'gh', name: 'GitHub', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com/login', match: null }] } }),
    item({ id: 'other', name: 'Other', login: { ...emptyLogin(), uris: [{ uri: 'https://example.com', match: null }] } }),
    item({ id: 'never', name: 'Never', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com', match: 5 }] } }),
    item({ id: 'dead', name: 'Dead', deletedAt: '2026-01-01T00:00:00.000000Z', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com', match: null }] } }),
  ];

  it('returns host matches', () => {
    expect(matchByDomain(items, 'https://github.com/login').map((i) => i.id)).toContain('gh');
  });

  // 用户显式设置的「永不」必须被尊重
  it('excludes entries whose uri match strategy is Never', () => {
    expect(matchByDomain(items, 'https://github.com/x').map((i) => i.id)).not.toContain('never');
  });

  it('excludes deleted items', () => {
    expect(matchByDomain(items, 'https://github.com/x').map((i) => i.id)).not.toContain('dead');
  });

  it('returns nothing for an unrelated host', () => {
    expect(matchByDomain(items, 'https://unrelated.test')).toEqual([]);
  });

  it('tolerates a malformed URL rather than throwing', () => {
    expect(() => matchByDomain(items, 'not a url')).not.toThrow();
    expect(matchByDomain(items, 'not a url')).toEqual([]);
  });

  it('accepts a scheme-less uri in the entry', () => {
    const bare = [item({ id: 'b', name: 'B', login: { ...emptyLogin(), uris: [{ uri: 'github.com', match: null }] } })];
    expect(matchByDomain(bare, 'https://github.com/x').map((i) => i.id)).toEqual(['b']);
  });
});
