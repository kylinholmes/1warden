import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * 守卫：**图标只有一条渲染路径**（`ItemIcon`）。
 *
 * ## 为什么需要它
 *
 * `IconGlyph` 是画那一块的（站点图标 → 彩色徽标 → 类型图标），
 * `ItemIcon` 是**决定画什么**的（从条目算 domain / 文字 / 色相）。
 *
 * 两端本来应该是：`ItemIcon` ← 数据。但扩展端**拿不到 `VaultItem`**
 * （弹窗只收摘要，spec 不变量 S1），于是它绕过 `ItemIcon`、
 * 拿摘要里那三个字段**直接调 `IconGlyph`** —— 桌面端的主列表、
 * 快速面板和弹窗，三处各写了一遍同样的五个 props。
 *
 * 后果不是「长得不一样」（那时它们恰好一样），是**将来改一处、
 * 另外两处不跟**：`ItemIcon` 加个兜底、改尺寸规则、处理 store 未命中，
 * 绕过它的那几处全都停在旧行为上，而界面上看不出来。
 *
 * 这正是这个仓库里反复出现的那一族。区别只在于它长得不像「两个 app 各写
 * 一遍」—— 它在一端内部绕了一层，所以之前没被归进去。
 *
 * ## 判据
 *
 * 整个仓库里，**只有 `ItemIcon.tsx` 自己**可以出现 `<IconGlyph`。
 * 其它任何地方要画图标，都得走 `ItemIcon`。
 */
const SOURCES = import.meta.glob(
  [
    './**/*.tsx',
    // 桌面端和扩展端都扫 —— 绕过发生在两端，只扫一边等于没守
    '../../../apps/desktop/src/**/*.tsx',
    '../../../apps/desktop/extension/**/*.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/**
 * ⚠️ 走 **AST**，不查 `src.includes('<IconGlyph')`。
 *
 * 用字符串查的话，`ItemRow.tsx` 里那句**注释**
 * （「`<IconGlyph domain text hue type store />`（它只拿得到摘要…）」）
 * 会被当成一处违规 —— 守卫报的第一条就是它。
 *
 * 这个仓库里另外三个守卫（`chrome-api-guard` / `hooks-order-guard` /
 * `shared-css-wiring`）的文档都写着同一条理由：**正则分不清注释里的例子**。
 * 我写这一条时忘了，于是自己又踩了一次。
 */
function rendersGlyph(source: string): boolean {
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
    ) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === 'IconGlyph') found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('图标只有一条渲染路径', () => {
  it('确实扫到了源码（不是扫了个空列表）', () => {
    const keys = Object.keys(SOURCES);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.some((k) => k.endsWith('ItemIcon.tsx'))).toBe(true);
    // 抽查两端各一处 —— glob 断了的话上面那条会因为「一个都没扫到」而恒过
    expect(keys.some((k) => k.endsWith('VaultView.tsx'))).toBe(true);
    expect(keys.some((k) => k.endsWith('popup/Popup.tsx'))).toBe(true);
  });

  it('除了 ItemIcon 自己，没有别处直接渲染 IconGlyph', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => rendersGlyph(src))
      .map(([path]) => path)
      // 定义它的那一个文件 —— 那里正是**唯一**该出现它的地方
      .filter((path) => !path.endsWith('ItemIcon.tsx'));

    expect(
      offenders,
      '这些地方绕过了 `ItemIcon` 直接渲染 `IconGlyph`。\n' +
        '`ItemIcon` 负责「从条目算出画什么」，绕过它意味着将来它改了\n' +
        '（加兜底、改尺寸、处理 store 未命中），这里不会跟着改 ——\n' +
        '而界面上看不出来。扩展端拿不到 `VaultItem` 时，把摘要里那几个\n' +
        '字段按 `IconProps` 传给 `ItemIcon` 即可。\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
