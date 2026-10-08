import { describe, it, expect } from 'vitest';
import { COMPACT_LAYOUT_QUERY } from '../../../packages/ui/src/layout';

/**
 * 守卫：`@1warden/ui` 导出的每一份 CSS，用到它的 app 都必须**真的引进来**。
 *
 * ## 为什么需要它
 *
 * 这个 bug 真的发生过，而且没有任何东西能发现：
 *
 * `IconGlyph` / `ItemIcon` 渲染的是 `.tile-img` / `.tile-avatar` / `.tile-glyph`，
 * 这三个类住在 `@1warden/ui/components.css`。扩展端的 `styles.css` 只引了
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
    './popup/main.tsx',
    // ⚠️ 桌面端的 styles.css 就在**上一层**。合并成一个 app 之前，扩展在
    // `apps/extension/src/`，到这里要绕 `../../../apps/desktop/`；现在两边
    // 同住 `apps/desktop/`，最短形式塌缩成了 `../src/`。glob 里写长的那个
    // 也能解析到同一个文件，但**拿回来的键是最短形式** —— 见下面按后缀查的说明。
    '../src/styles.css',
    '../src/screens/VaultView.tsx',
    '../../../packages/ui/src/components.css',
    '../../../packages/ui/package.json',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/**
 * ⚠️ 按**后缀**查，不按写下的路径查。
 *
 * Vite 会把 glob 的键规范化成最短形式，而**最短形式取决于测试文件自己住在哪**：
 *
 * | 测试文件的位置 | 写下的 glob | 拿回来的键 |
 * |---|---|---|
 * | `apps/extension/src/`（旧） | `'../../../apps/desktop/src/styles.css'` | `'../../desktop/src/styles.css'` |
 * | `apps/desktop/extension/`（今） | 同上 | `'../src/styles.css'` |
 *
 * 拿写下的字符串去索引会得到 `undefined`，而报出来的是「读不到 CSS」这种
 * 指错方向的错 —— **这个坑我踩了两次**，两次都是因为改了文件的位置。
 * 所以判据用后缀（`'src/styles.css'`），它跟着文件走、不跟着位置走。
 */
function sourceEndingWith(suffix: string): string | undefined {
  const key = Object.keys(FILES).find((k) => k.endsWith(suffix));
  return key === undefined ? undefined : FILES[key];
}

/** `@1warden/ui` 导出的全部 CSS 入口，形如 `['@1warden/ui/theme.css', …]` */
function sharedCssEntries(): string[] {
  const pkg = JSON.parse(sourceEndingWith('packages/ui/package.json')!) as {
    exports?: Record<string, unknown>;
  };
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.endsWith('.css'))
    .map((key) => `@1warden/ui/${key.replace(/^\.\//, '')}`);
}

describe('@1warden/ui 的 CSS 在两个 app 里都接上了', () => {
  it('共享包确实导出了 CSS（否则下面两条是空转的）', () => {
    const entries = sharedCssEntries();
    expect(entries).toContain('@1warden/ui/theme.css');
    expect(entries).toContain('@1warden/ui/components.css');
  });

  it('glob 确实读到了三份文件', () => {
    expect(sourceEndingWith('./styles.css')).toBeTypeOf('string');
    expect(sourceEndingWith('src/styles.css')).toBeTypeOf('string');
    expect(sourceEndingWith('packages/ui/package.json')).toBeTypeOf('string');
  });

  for (const [label, suffix] of [
    ['扩展端', './styles.css'],
    ['桌面端', 'src/styles.css'],
  ] as const) {
    it(`${label}引了共享包导出的每一份 CSS`, () => {
      const css = sourceEndingWith(suffix)! + (suffix === './styles.css' ? sourceEndingWith('src/styles.css')! : '');
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
    ['桌面端', 'src/styles.css'],
  ] as const) {
    it(`${label}声明了指向 packages/ui 的 @source`, () => {
      const css = sourceEndingWith(suffix)! + (suffix === './styles.css' ? sourceEndingWith('src/styles.css')! : '');
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
 * 第三个守卫：**弹窗的 body 必须有独立于视口的显式尺寸**。
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
 * 只检查 CSS 任意位置存在 width 仍然不够：Firefox 的标准模式量 body，
 * 而 html 的 max-width: 100vw 会依赖尚未确定的弹窗视口，结果仍然塌缩。
 * 这里守住声明约束；真实工具栏的尺寸由 scripts/toolbar-popup-smoke.ts 验收。
 */
describe('弹窗外壳的尺寸约束', () => {
  it('所有平台按可用宽度布局，导航不会由 hover 或焦点自动打开', () => {
    const css = sourceEndingWith('packages/ui/src/components.css')!.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain(`@media ${COMPACT_LAYOUT_QUERY}`);
    expect(css).toContain('@media (width >= 900px)');
    expect(css).not.toMatch(/@media\s*\(orientation:/);
    expect(css).not.toMatch(/@container (?:floating|vault|shell)/);
    expect(css).not.toMatch(/(?:nav-trigger|nav-drawer(?:-panel)?):(?:hover|focus-within)[^{]*\.nav-drawer-panel/);
  });
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

  it('弹窗由 body 声明尺寸，不依赖浏览器尚未确定的视口大小', () => {
    const css = sourceEndingWith('./styles.css')!;
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const body = [...rules.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(css).toContain("@import '../src/styles.css'");
    // Firefox measures body in standards mode. A fixed-size tab hides errors here.
    expect(body).toMatch(/(?:^|[;\s])width:\s*440px/);
    expect(body).toMatch(/(?:^|[;\s])height:\s*600px/);
    expect(rules).not.toMatch(/(?:max-)?(?:width|height):[^;}]*(?:vw|vh)/);
  });
});

/**
 * 第四个守卫：**渲染了抽屉就必须渲染开关**。
 *
 * ## 为什么需要它
 *
 * 这个 bug 真的发生过，而且把弹窗的导航**整个挡死**：`Popup.tsx` 渲染
 * `NavDrawer` 却没有 `NavTrigger`，理由是样式表里的一句
 * 「弹窗恒为抽屉，所以不需要开关」。
 *
 * 那句话把**状态**当成了**入口**：
 *
 * - 抽屉在流里宽度是 **0**（面板是 `position: absolute`），所以
 *   `.nav-drawer:hover` 永远不成立
 * - `focus-within` 也一样 —— 够不着就聚不上焦
 * - 剩下唯一能打开面板的，是 `.vault-shell:has(.nav-trigger:hover)` 那条
 *
 * 于是没有触发器 = 导航在界面上**完全够不着**：没有侧栏、没有按钮。
 *
 * ## 为什么没人发现
 *
 * 类型检查过（两个组件都在，只是没被渲染）、833 个测试过、构建过、
 * Firefox 打包过。它甚至**看起来是对的** —— 弹窗截图里少一个按钮，
 * 而少一个按钮不会让任何人觉得「坏了」，只会觉得「大概本来就没有」。
 *
 * 和另外三条是同一族：**产物看起来是好的**。
 */
describe('抽屉必须有一个够得着的开关', () => {
  it('这两份文件确实读到了（否则下面是空转的）', () => {
    expect(sourceEndingWith('popup/main.tsx')).toContain("from '../../src/App'");
    expect(sourceEndingWith('screens/VaultView.tsx')).toBeTypeOf('string');
  });

  for (const [label, suffix] of [
    ['共用 PC 页面', 'screens/VaultView.tsx'],
  ] as const) {
    it(`${label}渲染抽屉的同时渲染了开关`, () => {
      const tsx = sourceEndingWith(suffix)!;
      expect(
        tsx.includes('<NavDrawer'),
        `${label}不再渲染 NavDrawer 了 —— 这条守卫要跟着改，不是删掉`,
      ).toBe(true);
      expect(
        tsx.includes('<NavTrigger'),
        `${label}渲染了 NavDrawer 却没有 NavTrigger。\n` +
          '抽屉的面板是绝对定位的，抽屉本身在流里宽度为 0 —— 能打开它的\n' +
          '只有触发器（悬停联动靠 `.vault-shell:has(.nav-trigger:hover)`）。\n' +
          '没有触发器时导航在界面上**完全够不着**，而类型检查、单测、构建\n' +
          '全都不会报，截图里也只是「少了一个按钮」。',
      ).toBe(true);
    });
  }
});
