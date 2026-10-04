import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // 契约测试需要运行中的服务器，故意排除在单元测试之外 ——
    // `bun run test` 必须永远不需要网络。
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.contract.test.ts'],
    environment: 'node',
  },
});
