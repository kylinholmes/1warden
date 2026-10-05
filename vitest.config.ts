import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // 契约测试需要运行中的服务器，故意排除在单元测试之外 ——
    // `bun run test` 必须永远不需要网络。
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.contract.test.ts'],
    environment: 'node',
    /*
     * 让测试能读到 **CSS 源码**。
     *
     * 默认是关的，而关着的时候 `.css` 导入一律返回**空字符串** ——
     * 连 `?raw` 也一样（Vitest 在更底层就把它截掉了，不是 glob 的问题）。
     * 症状很误导：读到的长度是 0，看起来像「文件不存在」或「路径写错了」。
     *
     * 需要它的是 `shared-css-wiring.test.ts`：那个 bug（扩展端漏引
     * `@coffer/ui/components.css`，弹窗图标全裸）只有直接看 CSS 源码才抓得到 ——
     * 类型检查、构建、跑在 node 里的单测全都看不见样式。
     *
     * 目前没有任何别的测试导入 CSS，所以打开它不影响既有行为。
     */
    css: true,
  },
});
