import { test, expect, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { McpRateLimiter } from '@/lib/mcp/rate-limiter';

const PREFIX = `vitest-rl-${Date.now()}`;
const createdIds: string[] = [];

function createFixtureUser(overrides: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `${PREFIX}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      name: 'RateLimit Test',
      mcpRpmLimit: 2,
      dailyMcpQuota: 5,
      singleCallTokenCap: 4000,
      ...overrides,
    },
  });
}

function dayKey() {
  return new Date().toISOString().split('T')[0];
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
});

test('正常放行：headers 反映用户配置 + 账本按日计数落库', async () => {
  const user = await createFixtureUser();
  createdIds.push(user.id);
  const r = await McpRateLimiter.checkLimit(user.id);
  expect(r.allowed).toBe(true);
  expect(r.status).toBe(200);
  expect(r.headers['x-ratelimit-limit-rpm']).toBe('2');
  expect(r.headers['x-ratelimit-limit-daily']).toBe('5');
  const ledger = await prisma.mcpUsageLedger.findUnique({ where: { userId_day: { userId: user.id, day: dayKey() } } });
  expect(ledger?.mcpCalls).toBe(1);
});

test('RPM 超限：rpm=2 第 3 次 → 429 + Retry-After + limitType RPM', async () => {
  const user = await createFixtureUser({ dailyMcpQuota: 100 });
  createdIds.push(user.id);
  await McpRateLimiter.checkLimit(user.id);
  await McpRateLimiter.checkLimit(user.id);
  const r = await McpRateLimiter.checkLimit(user.id);
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe('RPM_EXCEEDED');
  expect(r.status).toBe(429);
  expect(r.headers['Retry-After']).toBe('60');
  expect(r.errorJson?.error?.data?.limitType).toBe('RPM');
});

test('每日配额超限：429 DAILY_QUOTA + 账本持久计数', async () => {
  const user = await createFixtureUser({ mcpRpmLimit: 100, dailyMcpQuota: 1 });
  createdIds.push(user.id);
  const first = await McpRateLimiter.checkLimit(user.id);
  expect(first.allowed).toBe(true);
  // 账本计到上限，模拟当日已耗尽（绕过 RPM 窗口干扰）
  await prisma.mcpUsageLedger.update({ where: { userId_day: { userId: user.id, day: dayKey() } }, data: { mcpCalls: 1 } });
  const r = await McpRateLimiter.checkLimit(user.id);
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe('DAILY_QUOTA_EXCEEDED');
  expect(r.status).toBe(429);
  expect(r.errorJson?.error?.data?.limitType).toBe('DAILY_QUOTA');
});

test('封禁 → 403 BANNED + 标记头 + 不记账', async () => {
  const user = await createFixtureUser({ isBanned: true });
  createdIds.push(user.id);
  const r = await McpRateLimiter.checkLimit(user.id);
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe('BANNED');
  expect(r.status).toBe(403);
  expect(r.headers['x-ratelimit-banned']).toBe('true');
  const ledger = await prisma.mcpUsageLedger.findUnique({ where: { userId_day: { userId: user.id, day: dayKey() } } });
  expect(ledger).toBeNull();
});

test('admin 覆盖：daily 0 / rpm 600 / tokenCap 32000', async () => {
  const user = await createFixtureUser();
  createdIds.push(user.id);
  const r = await McpRateLimiter.checkLimit(user.id, 'ADMIN');
  expect(r.allowed).toBe(true);
  expect(r.dailyLimit).toBe(0);
  expect(r.rpmLimit).toBe(600);
  expect(r.tokenCap).toBe(32000);
});
