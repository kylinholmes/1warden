import { describe, expect, it } from 'vitest';

/**
 * 守卫：`env(safe-area-inset-*)` 和 `viewport-fit=cover` **必须成对出现**。
 *
 * ## 为什么需要它
 *
 * 这两样东西住在**两个不同的文件**里，而且**少一个不会报任何错**：
 *
 * | | 在哪 | 少了会怎样 |
 * |---|---|---|
 * | `env(safe-area-inset-top)` | CSS | 读不到就是 `0`，刘海下的内容被压住 |
 * | `viewport-fit=cover` | HTML 的 `<meta viewport>` | 不写则**上面那个全体返回 0** |
 *
 * 注意第二行：**没写 `viewport-fit=cover` 的时候，`env()` 不报错、不警告，
 * 它老老实实返回 0**。于是「让出了安全区」和「根本没让」在代码上长得一模一样，
 * 只有真机上才看得出差别 —— 而这个 bug 的样子是「内容被刘海压住」，
 * 很容易被当成「那个型号的问题」。
 *
 * 所以唯一能守住它的地方，是直接断言这两件事**同时**存在。
 *
 * ⚠️ glob 用**根绝对路径**（`/apps/...`），不用相对的。
 *
 * 相对路径的键是「你写下的那个字符串」，而它取决于测试文件住在哪 ——
 * 从这个文件看是 `'./styles.css'`，换个位置就变成 `'../src/styles.css'`。
 * 拿后缀 `'src/styles.css'` 去查 `'./styles.css'` 会得到 `undefined`，
 * 而报出来的是「读不到文件」这种指错方向的错；这个坑在
 * `shared-css-wiring.test.ts` 里踩过两次，那里写得更详细。
 *
 * 根绝对路径的键是稳定的，后缀也就跟着稳定。
 */
const FILES = import.meta.glob(
  [
    '/apps/desktop/index.html',
    '/apps/desktop/src/styles.css',
    '/packages/ui/src/theme.css',
    '/packages/ui/src/components.css',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function sourceEndingWith(suffix: string): string | undefined {
  const key = Object.keys(FILES).find((k) => k.endsWith(suffix));
  return key === undefined ? undefined : FILES[key];
}

/** 用了 `env(safe-area-inset-*)` 的样式表，按根相对的路径列出 */
function cssUsingSafeArea(): string[] {
  return [
    'apps/desktop/src/styles.css',
    'packages/ui/src/theme.css',
    'packages/ui/src/components.css',
  ].filter((name) => sourceEndingWith(name)?.includes('env(safe-area-inset') === true);
}

describe('安全区：CSS 和 viewport meta 必须成对', () => {
  it('glob 确实读到了这四份文件（否则下面全是空转的）', () => {
    expect(sourceEndingWith('index.html')).toBeDefined();
    expect(sourceEndingWith('src/styles.css')).toBeDefined();
    expect(sourceEndingWith('src/theme.css')).toBeDefined();
    expect(sourceEndingWith('src/components.css')).toBeDefined();
  });

  /*
   * ⚠️ 这一条是**防空转**的，不是凑数。
   *
   * 下面那条断言的形状是「用了 safe-area ⇒ 必须写了 viewport-fit」。
   * 如果哪天有人把 safe-area 那段 CSS 删了，**蕴含式会变成真** ——
   * 测试照样绿，而它守的东西已经不在了。所以先把「前提确实成立」钉住。
   */
  it('前提成立：确实有样式表在用 safe-area', () => {
    expect(cssUsingSafeArea()).toContain('apps/desktop/src/styles.css');
  });

  /*
   * ⚠️ 断言的是**那个 meta 标签**，不是「文件里有没有这个字符串」。
   *
   * 第一版就是直接 `html.includes('viewport-fit=cover')`。**它抓不到东西** ——
   * 因为 index.html 顶上那段注释里为了讲清楚这件事，自己就写着
   * `viewport-fit=cover` 好几个字。于是把 meta 上的属性删掉，测试**照样绿**。
   *
   * 我是靠「故意改坏再看它红不红」发现的：去掉属性 → 4 passed。一个
   * 永远不会红的守卫比没有守卫更糟，因为它给人的是「有人在看着」的错觉。
   *
   * 同一个坑在这个仓库里出现过一次：`icon-path.test.ts` 第一版用字符串查
   * `<IconGlyph`，结果匹配到了 `ItemRow.tsx` 里的一句文档注释 —— 那一次
   * 改用 AST 解决的。这次不用 AST，改成先取出**那个标签**再看它的属性：
   * 注释里出现什么都不影响。
   */
  it('只要用了 safe-area，那个 viewport meta 就必须带 viewport-fit=cover', () => {
    const html = sourceEndingWith('index.html')!;
    if (cssUsingSafeArea().length === 0) return;

    const meta = /<meta\s+name=["']viewport["'][^>]*>/i.exec(html)?.[0];
    expect(meta, 'index.html 里找不到 <meta name="viewport">').toBeDefined();
    expect(
      meta!.includes('viewport-fit=cover'),
      '有样式表用了 env(safe-area-inset-*)，但这个 viewport meta 里没有 ' +
        'viewport-fit=cover —— 那样 env() 会**全部返回 0**，安全区形同虚设，' +
        '而且不会报任何错。',
    ).toBe(true);
  });

  it('移动端的 --titlebar-h 来自安全区，不是那个 28px 的红绿灯高度', () => {
    const css = sourceEndingWith('src/styles.css')!;
    // iOS / Android 那一档必须读 env(safe-area-inset-top)
    const mobileRule = /:root\[data-os=['"](ios|android)['"]\][^{]*\{[^}]*--titlebar-h:\s*env\(safe-area-inset-top/;
    expect(
      mobileRule.test(css),
      'iOS/Android 的 --titlebar-h 应该是 env(safe-area-inset-top, 0px)。' +
        '写成固定值的话，不同机型（刘海 / 灵动岛 / 无刘海）会各不相同地错。',
    ).toBe(true);
  });
});
