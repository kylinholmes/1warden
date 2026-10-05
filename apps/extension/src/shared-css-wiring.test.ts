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
    './popup/Popup.tsx',
    '../../../apps/desktop/src/styles.css',
    '../../../packages/ui/src/components.css',
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

/**
 * 第二个守卫：**Tailwind 得知道去扫共享包**。
 *
 * 和上面那条是同一个病的**不同机制** —— 上面管的是 `.css` 文件有没有被
 * `@import` 进来，这条管的是**工具类有没有被生成**。
 *
 * Tailwind 4 按构建根目录自动找源文件，而 `packages/ui` 在 app 外面：
 * 不写 `@source` 的话，那些组件里用到的工具类**一个都不会被生成** ——
 * 类名在 DOM 上、规则不在产物里。构建、类型检查、单测全都不报，
 * 只有肉眼看得见。
 *
 * ⚠️ 已经有实例：`Section` 的 `mb-7` 在搬进共享包之后消失，
 * 表现是「详情里两个分组贴在一起」—— 而两端各自读代码都完全正常。
 * 这条不变量此前**只靠人记得**。
 */
describe('两个 app 都告诉 Tailwind 去扫共享包', () => {
  for (const [label, suffix] of [
    ['扩展端', './styles.css'],
    ['桌面端', 'desktop/src/styles.css'],
  ] as const) {
    it(`${label}声明了指向 packages/ui 的 @source`, () => {
      const css = sourceEndingWith(suffix)!;
      expect(
        css.includes("'../../../packages/ui/src'"),
        `${label}的 styles.css 没有 @source 指向 packages/ui ——\n` +
          '那些组件里用到的工具类不会出现在产物里，而构建、类型检查、单测都不会报。\n' +
          "补一行：@source '../../../packages/ui/src';",
      ).toBe(true);
    });
  }
});

/**
 * 第三个守卫：**弹窗必须有显式宽度**。
 *
 * `.vault-shell` 上有 `container-type: inline-size`，而 inline-size 容器
 * **算宽度时假装自己没有内容**。浏览器弹窗恰恰是按内容撑开的 ——
 * 于是它算出 0 宽，整个弹窗缩成一条线。
 *
 * ⚠️ 这个真的发生过，而且把用户挡在外面。抓不到它的原因值得记下来：
 * **preview 截图看不见** —— 截图工具总是给一个固定视口宽度，
 * 所以「弹窗撑不开」这件事在仪器里根本不出现。
 * 我是靠用户发来的截图才知道的。
 *
 * 所以这条守卫不测渲染，只测**这两件事必须同时成立**：
 * 外壳是 inline-size 容器 ⟹ 弹窗根元素有显式的宽度。
 */
describe('弹窗外壳的尺寸约束', () => {
  it('⚠️ 外壳本身**不是** inline-size 容器', () => {
    const css = sourceEndingWith('packages/ui/src/components.css')!;
    const shell = css.match(/\.vault-shell \{[^}]*\}/)?.[0] ?? '';
    expect(shell, '没找到 .vault-shell 规则 —— 选择器变了就要一起改').not.toBe('');
    expect(
      shell.includes('container-type'),
      '`.vault-shell` 上不该有 container-type。\n' +
        '它是**弹窗的根元素**，而浏览器弹窗是按内容撑开的 —— ' +
        'inline-size 容器「算宽度时假装自己没有内容」，结果是整个弹窗被压成一条。\n' +
        '（桌面端看不出来：Tauri 窗口有固定尺寸。截图工具也看不出来：' +
        '它总是给固定视口宽度 —— 这个 bug 两次都是从用户截图发现的。）\n' +
        '容器该挂在 `.vault-content` 上，或者桌面端自己的 `.app-shell` 上。',
    ).toBe(false);
  });

  it('内容区仍然是容器（否则并排那条规则是空转的）', () => {
    const css = sourceEndingWith('packages/ui/src/components.css')!;
    const content = css.match(/\.vault-content \{[^}]*\}/)?.[0] ?? '';
    expect(content).toContain('container-type: inline-size');
    expect(content).toContain('container-name: vault');
  });

  it('弹窗根元素声明了显式宽度', () => {
    const tsx = sourceEndingWith('popup/Popup.tsx')!;
    const root = tsx.match(/<div className="screen-in vault-shell[^"]*"/)?.[0] ?? '';
    expect(root, '没找到弹窗根元素 —— 选择器变了就要一起改').not.toBe('');
    expect(
      /w-\[\d+px\]/.test(root),
      '弹窗根元素没有显式宽度。弹窗是个**稳定的窗口**：切分类、进详情、' +
        '出错提示进出，都不该让它忽宽忽窄 —— 而长度不一的列表内容会让' +
        '「按内容撑开」每次都给出不同的宽度。加一个 `w-[440px]`。\n' +
        '根元素：' + root,
    ).toBe(true);
  });
});
