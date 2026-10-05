import { describe, it, expect } from 'vitest';

/**
 * 守卫：`@coffer/ui` 导出的每一份 CSS，用到它的 app 都必须**真的引进来**。
 *
 * ## 为什么需要它
 *
 * 这个 bug 真的发生过，而且没有任何东西能发现：
 *
 * `IconGlyph` / `ItemIcon` 渲染的是 `.tile-img` / `.tile-avatar` / `.tile-glyph`，
 * 这三个类住在 `@coffer/ui/components.css`。扩展端的 `styles.css` 只引了
 * `theme.css` —— 于是**类名在 DOM 上、规则却不在产物里**：弹窗里的条目图标
 * 没有 34px 尺寸、没有圆角、没有彩色底，全裸着。
 *
 * 为什么没有人发现：
 *
 * - **类型检查**：类名是字符串，TS 不看 CSS
 * - **单元测试**：全部跑在 node 环境，没有 DOM，更没有样式
 * - **构建**：少引一个 CSS 文件不影响任何东西成功产出
 * - **截图**：桌面端引全了，看起来完全正常 —— 只有弹窗是坏的
 *
 * 也就是「静默失效」那一族，和 `chrome.*` 那件事同一类：**产物看起来是好的**。
 * 唯一能守住它的地方，就是直接断言「引入关系」本身。
 *
 * ⚠️ 判据用**共享包自己的 exports** 而不是写死两个文件名：将来包多导出一份
 * `print.css`，这里会自己跟上，不用记得回来改。
 */
const FILES = import.meta.glob(
  [
    './styles.css',
    '../../../apps/desktop/src/styles.css',
    '../../../packages/ui/package.json',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/**
 * ⚠️ 按**后缀**查，不按写下的路径查。
 *
 * Vite 会把 glob 的键规范化成最短形式：`'../../../apps/desktop/src/styles.css'`
 * 拿回来的键是 `'../../desktop/src/styles.css'`（`../../../apps/` 就等于 `../../`）。
 * 拿写下的字符串去索引会得到 `undefined`，而且报出来的是「读不到 CSS」这种
 * 指错方向的错 —— 我自己先踩了一次。
 */
function sourceEndingWith(suffix: string): string | undefined {
  const key = Object.keys(FILES).find((k) => k.endsWith(suffix));
  return key === undefined ? undefined : FILES[key];
}

/** `@coffer/ui` 导出的全部 CSS 入口，形如 `['@coffer/ui/theme.css', …]` */
function sharedCssEntries(): string[] {
  const pkg = JSON.parse(sourceEndingWith('packages/ui/package.json')!) as {
    exports?: Record<string, unknown>;
  };
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.endsWith('.css'))
    .map((key) => `@coffer/ui/${key.replace(/^\.\//, '')}`);
}

describe('@coffer/ui 的 CSS 在两个 app 里都接上了', () => {
  it('共享包确实导出了 CSS（否则下面两条是空转的）', () => {
    const entries = sharedCssEntries();
    expect(entries).toContain('@coffer/ui/theme.css');
    expect(entries).toContain('@coffer/ui/components.css');
  });

  it('glob 确实读到了三份文件', () => {
    expect(sourceEndingWith('./styles.css')).toBeTypeOf('string');
    expect(sourceEndingWith('desktop/src/styles.css')).toBeTypeOf('string');
    expect(sourceEndingWith('packages/ui/package.json')).toBeTypeOf('string');
  });

  for (const [label, suffix] of [
    ['扩展端', './styles.css'],
    ['桌面端', 'desktop/src/styles.css'],
  ] as const) {
    it(`${label}引了共享包导出的每一份 CSS`, () => {
      const css = sourceEndingWith(suffix)!;
      const missing = sharedCssEntries().filter((entry) => !css.includes(`@import '${entry}'`));
      expect(
        missing,
        `${label}的 styles.css 少了这些 @import —— 缺了的话，用到那些类的组件` +
          `会以「没有样式」的样子渲染出来，而构建、类型检查、单测都不会报：\n` +
          missing.map((m) => `  @import '${m}';`).join('\n'),
      ).toEqual([]);
    });
  }
});
