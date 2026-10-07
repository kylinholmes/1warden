/**
 * 列表排序 —— 纯函数，桌面端和扩展端共用一份。
 *
 * ## 为什么名称排序要用 `Intl.Collator` 而不是 `<`
 *
 * 码点比较对中文是**按 Unicode 排**，而那不是人读的顺序：
 *
 *     '<' 比较：  丁 < 张 < 李 < 王    （按码点：丁(U+4E01) < 张(U+5F20) < 李(U+674E) < 王(U+738B)）
 *     Intl：      丁 < 李 < 王 < 张    （按拼音，多数中文用户预期这个）
 *
 * 而密码管理器的列表里中英文混排是常态（「GitHub」「公司 VPN」「邮箱」），
 * 码点比较会把所有中文排到英文后面，看起来像「没排序」。
 *
 * `numeric: true` 管的是「条目 2」和「条目 10」—— 按码点 10 排在 2 前面。
 * 导入进来的条目名里带数字很常见。
 *
 * ⚠️ `Intl.Collator` 实例要**建一次复用**：它内部要加载语言数据，
 * 每次比较都新建的话排序 250 条会卡出可见的停顿。
 */
import type { VaultItem } from './model';

export const SORT_BY = {
  /** 最近改动的在前 —— 默认。用户多半是来找刚改过的那条 */
  updated: 'updated',
  /** 最近创建的在前 */
  created: 'created',
  /** 按名称，字典序（中文按拼音） */
  name: 'name',
} as const;

export type SortBy = (typeof SORT_BY)[keyof typeof SORT_BY];

export const SORT_LABEL: Record<SortBy, string> = {
  updated: '最近改动',
  created: '最近创建',
  name: '名称',
};

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/**
 * 排序。**不改动入参** —— 会话里那个数组是共享的，就地排会污染它，
 * 而表现是「切了分类之后顺序莫名其妙变了」。
 *
 * ⚠️ 解不开名字的条目（`nameFailed`）永远排在最后，且**不受方向影响**。
 * 它们是坏数据，不是「名字以某个字符开头的条目」—— 跟着倒序跑到最前面
 * 会很突兀，而且用户点它也没有意义。
 */
export function sortItems<T extends Pick<VaultItem, 'name' | 'nameFailed' | 'createdAt' | 'updatedAt'>>(items: readonly T[], by: SortBy): T[] {
  const out = items.slice();

  if (by === SORT_BY.name) {
    out.sort((a, b) => {
      if (a.nameFailed !== b.nameFailed) return a.nameFailed ? 1 : -1;
      return collator.compare(a.name, b.name);
    });
    return out;
  }

  // 时间字段是 ISO 8601 字符串，字典序即时间序 —— 不用 Date.parse
  // （解析 250 个时间串比比较字符串慢一个数量级，而结果一样）
  const field = by === SORT_BY.created ? 'createdAt' : 'updatedAt';
  out.sort((a, b) => {
    if (a.nameFailed !== b.nameFailed) return a.nameFailed ? 1 : -1;
    const av = a[field];
    const bv = b[field];
    /*
     * 倒序：新的在前。
     *
     * 缺失的时间（空串）自然落到最后 —— 不用单独判。
     * 这里原本有两行 `if (av === '') return 1` / `if (bv === '') return -1`，
     * 看着是在处理「没有时间」，实际什么都没做：空串在字典序里最小，
     * 通用分支给出的结果和它们一模一样。
     *
     * **变异测试抓到的**：把那两行删掉，全部的测试照样绿 ——
     * 不是测试没测到，是那两行是死代码。
     */
    if (av === bv) return 0;
    return av < bv ? 1 : -1;
  });
  return out;
}
