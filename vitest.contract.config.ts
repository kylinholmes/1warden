import { defineConfig } from 'vitest/config';

/**
 * 契约测试的配置，与单元测试分开。
 *
 * 前置：
 *   ./scripts/dev-server.sh start
 *   bun run seed
 *   bun run test:contract
 *
 * `fileParallelism: false` —— 多个测试共用同一个账户与保险库，
 * 并发跑会互相干扰（比如一个测试删掉了另一个刚创建的条目）。
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.contract.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
