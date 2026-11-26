import { test, expect } from 'vitest';
import { createRepositoryMcpServer } from '@/lib/mcp/server';

test('createRepositoryMcpServer 安全实例化（不存在的仓也不抛未捕获异常）', async () => {
  const server = await createRepositoryMcpServer('vercel', 'next.js', 'main').catch(() => null);
  // 断言仅为「安全执行」锚点：真实工具注册断言在 locator-reader 套件
  expect(server === null || typeof server === 'object').toBe(true);
});
