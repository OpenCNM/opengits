import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * 单元/集成双层测试配置：
 * - tests/unit：纯逻辑 + vi.mock prisma（无 DB 依赖）—— `npm run test:unit`
 * - tests/integration：真实本地 DB —— `npm run test:integration`
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
    env: { PRISMA_QUERY_LOG: 'false' },
    testTimeout: 30_000,
  },
});
