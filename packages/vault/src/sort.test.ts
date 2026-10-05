import { describe, it, expect } from 'vitest';
import { sortItems, SORT_BY } from './sort';
import { emptyLogin, type VaultItem } from './model';

function item(over: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return {
    type: 'login', rawType: 1, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null, archivedAt: null, wrappedKey: null,
    login: emptyLogin(), card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

describe('sortItems', () => {
  /**
   * ⚠️ **不能就地排序。** 会话里那个数组是共享的，就地排会污染它 ——
   * 表现是「切了分类之后顺序莫名其妙变了」，而且刷新一次又好了。
   */
  it('不修改入参', () => {
    const items = [item({ id: '1', name: 'B' }), item({ id: '2', name: 'A' })];
    const before = items.map((i) => i.id);
    sortItems(items, SORT_BY.name);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('按名称升序', () => {
    const items = [item({ id: '1', name: 'C' }), item({ id: '2', name: 'A' }), item({ id: '3', name: 'B' })];
    expect(sortItems(items, SORT_BY.name).map((i) => i.name)).toEqual(['A', 'B', 'C']);
  });

  /**
   * ⚠️ 这条是这个模块存在的理由。
   *
   * 中文按**拼音**排而不是按 Unicode 码点 —— 码点比较会把「丁张李王」
   * 排成 丁张李王（U+4E01 < U+5F20 < U+674E < U+738B），
   * 而人读的顺序是「丁李王张」。列表里中英混排是常态，
   * 码点比较还会把所有中文排到英文后面，看起来像「根本没排序」。
   */
  it('★ 中文按拼音排，不是按码点', () => {
    const names = ['王', '李', '张', '丁'];
    const items = names.map((n, i) => item({ id: String(i), name: n }));
    expect(sortItems(items, SORT_BY.name).map((i) => i.name))
      .toEqual(['丁', '李', '王', '张']);
  });

  /** 「条目 2」要排在「条目 10」前面 —— 按码点 10 会跑到 2 前面 */
  it('★ 名字里的数字按数值比较', () => {
    const items = ['条目 10', '条目 2', '条目 1'].map((n, i) => item({ id: String(i), name: n }));
    expect(sortItems(items, SORT_BY.name).map((i) => i.name))
      .toEqual(['条目 1', '条目 2', '条目 10']);
  });

  it('时间倒序 —— 新的在前', () => {
    const items = [
      item({ id: 'old', name: 'x', updatedAt: '2026-01-01T00:00:00Z' }),
      item({ id: 'new', name: 'y', updatedAt: '2026-06-01T00:00:00Z' }),
      item({ id: 'mid', name: 'z', updatedAt: '2026-03-01T00:00:00Z' }),
    ];
    expect(sortItems(items, SORT_BY.updated).map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('按创建时间排是另一个字段', () => {
    const items = [
      item({ id: 'a', name: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }),
      item({ id: 'b', name: 'y', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }),
    ];
    expect(sortItems(items, SORT_BY.created).map((i) => i.id)).toEqual(['b', 'a']);
    expect(sortItems(items, SORT_BY.updated).map((i) => i.id)).toEqual(['a', 'b']);
  });

  /** 缺失的时间排最后，不排最前 —— 空串按字典序是最小的，不管就会跑到开头 */
  it('没有时间的排最后', () => {
    const items = [
      item({ id: 'none', name: 'x', updatedAt: '' }),
      item({ id: 'has', name: 'y', updatedAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(sortItems(items, SORT_BY.updated).map((i) => i.id)).toEqual(['has', 'none']);
  });

  /**
   * ⚠️ 解不开名字的条目**永远**在最后，且**不受方向影响**。
   *
   * 它们是坏数据，不是「名字以某个字符开头的条目」—— 跟着倒序跑到最前面
   * 会很突兀，而且用户点进去也没有意义。
   */
  it('★ 解不开名字的条目始终排在最后', () => {
    const items = [
      item({ id: 'bad', name: '无法解密', nameFailed: true }),
      item({ id: 'z', name: 'Z' }),
      item({ id: 'a', name: 'A' }),
    ];
    expect(sortItems(items, SORT_BY.name).map((i) => i.id)).toEqual(['a', 'z', 'bad']);
    expect(sortItems(items, SORT_BY.updated).map((i) => i.id).at(-1)).toBe('bad');
  });
});
