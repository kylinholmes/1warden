import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * ⚠️ 第三条是扩展的测试：它们住在 `extension/` 子目录而不是 `src/` ——
     * 那是**另一个构建目标**的代码（content script / popup / service worker），
     * 不属于桌面端的 `src/`。漏掉这一条的话，那些守卫测试会静默地一条都不跑，
     * 而少跑测试不会报错，只是「通过」得比平时快。
     *
     * （写这条注释时踩了个老坑：第一版里直接写了 glob 原文，里面的
     *  `星号斜杠` 把块注释提前闭合了 —— 和 host-impl.ts 里那次一模一样。）
     */
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/extension/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
    ],
    // 契约测试需要运行中的服务器，故意排除在单元测试之外 ——
    // `bun run test` 必须永远不需要网络。
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.contract.test.{ts,tsx}'],
    environment: 'node',
    /*
     * 让测试能读到 **CSS 源码**。
     *
     * 默认是关的，而关着的时候 `.css` 导入一律返回**空字符串** ——
     * 连 `?raw` 也一样（Vitest 在更底层就把它截掉了，不是 glob 的问题）。
     * 症状很误导：读到的长度是 0，看起来像「文件不存在」或「路径写错了」。
     *
     * 需要它的是 `shared-css-wiring.test.ts`：那个 bug（扩展端漏引
     * `@1warden/ui/components.css`，弹窗图标全裸）只有直接看 CSS 源码才抓得到 ——
     * 类型检查、构建、跑在 node 里的单测全都看不见样式。
     *
     * 目前没有任何别的测试导入 CSS，所以打开它不影响既有行为。
     */
    css: true,
  },
});
