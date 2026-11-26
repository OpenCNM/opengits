import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * 三层测试架构配置：
 * - tests/unit：纯逻辑单元边界（<= 75 文件，<= 5 处 `vi.mock(`）—— `npm run test:unit`
 * - tests/integration：真实本地 DB 与时序/流集成测试 —— `npm run test:integration`
 * - tests/golden：零外部依赖 Golden Diff（文本/AST/渲染管线）—— `npm run test:golden`
 * - forks 文件池：单文件单进程，防 prisma 单例/内存态跨文件串扰
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'apps/client/src') },
  },
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/golden/**', 'apps/client/tests/**'],
    env: { PRISMA_QUERY_LOG: 'false' },
    testTimeout: 30_000,
  },
});
