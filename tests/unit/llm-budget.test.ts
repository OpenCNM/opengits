import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LLM 预算熔断单测：BYOK 豁免 / 双层阈值 / 熔断关闭与双 0 不设限 /
 * 放行决策缓存（拒绝不缓存）/ admin 热调即时刷新。
 */

const aggregateMock = vi.fn();
const configFindUniqueMock = vi.fn();
const configCreateMock = vi.fn();
const configUpsertMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    tokenUsageLog: { aggregate: aggregateMock },
    platformBudgetConfig: {
      findUnique: configFindUniqueMock,
      create: configCreateMock,
      upsert: configUpsertMock,
    },
  },
}));

function cfg(over: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    perUserDailyTokens: 1000,
    platformDailyTokens: 5000,
    breakerEnabled: true,
    updatedAt: new Date(),
    ...over,
  };
}

describe('llm-budget(平台预算熔断)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configFindUniqueMock.mockResolvedValue(cfg());
    configUpsertMock.mockImplementation(async ({ update }: { update: Record<string, unknown> }) =>
      cfg(update));
  });

  async function freshMod() {
    vi.resetModules();
    return import('@/lib/llm-budget');
  }

  it('BYOK(keyOrigin=user) 永久豁免：不触发任何聚合查询', async () => {
    const m = await freshMod();
    await expect(
      m.checkLlmBudget({ userId: 'u1', keyOrigin: 'user' }),
    ).resolves.toBeUndefined();
    expect(aggregateMock).not.toHaveBeenCalled();
  });

  it('per-user 超限 → 抛 user 域 BudgetExceededError', async () => {
    const m = await freshMod();
    aggregateMock.mockImplementation(async ({ where }) => ({
      _sum: { totalTokens: where.userId ? 1500 : 3000 },
    }));
    await expect(m.checkLlmBudget({ userId: 'u1' })).rejects.toMatchObject({ scope: 'user' });
  });

  it('platform 全局超限 → 抛 platform 域异常', async () => {
    const m = await freshMod();
    // 用户内未超(100<1000)，全局超(9000>5000)
    aggregateMock.mockImplementation(async ({ where }) => ({
      _sum: { totalTokens: where.userId ? 100 : 9000 },
    }));
    await expect(m.checkLlmBudget({ userId: 'u2' })).rejects.toMatchObject({ scope: 'platform' });
  });

  it('breakerEnabled=false 或双 0 阈值 = 不设限', async () => {
    const m = await freshMod();
    configFindUniqueMock.mockResolvedValue(cfg({ breakerEnabled: false }));
    aggregateMock.mockResolvedValue({ _sum: { totalTokens: 999999 } });
    await expect(m.checkLlmBudget({ userId: 'u3' })).resolves.toBeUndefined();

    configFindUniqueMock.mockResolvedValue(cfg({ perUserDailyTokens: 0, platformDailyTokens: 0 }));
    await expect(m.checkLlmBudget({ userId: 'u3' })).resolves.toBeUndefined();
  });

  it('放行决策缓存复用；拒绝后阈值热调即时恢复', async () => {
    const m = await freshMod();
    // 首次：用户域超限
    aggregateMock.mockResolvedValue({ _sum: { totalTokens: 9999 } });
    await expect(m.checkLlmBudget({ userId: 'u4' })).rejects.toBeTruthy();

    // admin 热调解除 + 提高阈值 → 同一调用立即恢复（拒绝不缓存）
    configUpsertMock.mockResolvedValue(cfg({ breakerEnabled: false }));
    await m.updateBudgetConfig({ breakerEnabled: false });
    await expect(m.checkLlmBudget({ userId: 'u4' })).resolves.toBeUndefined();
  });

  it('getBudgetStatus 返回当日水位与使用百分比原料', async () => {
    const m = await freshMod();
    aggregateMock.mockResolvedValue({ _sum: { totalTokens: 2500 } });
    const s = await m.getBudgetStatus();
    expect(s.platformSpentToday).toBe(2500);
    expect(s.platformDailyTokens).toBe(5000);
  });

  it('source 分桶：通道超限抛 source 域异常，不拖垮未配桶通道', async () => {
    const m = await freshMod();
    configFindUniqueMock.mockResolvedValue(
      cfg({ sourceQuotas: { publish_review: 500 } }),
    );
    // 全局/用户未超；publish_review 桶已烧 600 ≥ 500 → 通道熔断
    aggregateMock.mockImplementation(async ({ where }) => ({
      _sum: { totalTokens: where.source === 'publish_review' ? 600 : 100 },
    }));
    await expect(
      m.checkLlmBudget({ userId: 'u1', keyOrigin: 'platform', source: 'publish_review' }),
    ).rejects.toMatchObject({ scope: 'source', source: 'publish_review' });

    // 未配桶的 source 不受分桶影响，仅走全局闸
    await expect(
      m.checkLlmBudget({ userId: 'u1', keyOrigin: 'platform', source: 'other_channel' }),
    ).resolves.toBeUndefined();
  });

  it('sourceQuotas 非法条目归一丢弃；JSONB 缺省视作空桶', async () => {
    const m = await freshMod();
    expect(
      m.normalizeSourceQuotas({ ok: 100, negative: -5, junk: 'x', zero: 0, arr: [1] }),
    ).toEqual({ ok: 100, zero: 0 });
    expect(m.normalizeSourceQuotas(undefined)).toEqual({});
    expect(m.normalizeSourceQuotas('junk')).toEqual({});
  });

  it('budgetAllowCache 缓存放行决策：30s 内同一用户+source 零重复聚合查库，invalidate 强制穿透', async () => {
    const m = await freshMod();
    aggregateMock.mockResolvedValue({ _sum: { totalTokens: 100 } });

    // 首次：查询 DB 聚合
    await m.checkLlmBudget({ userId: 'u-cache', source: 'test-src' });
    const callsAfterFirst = aggregateMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 第二次（模拟同一文档下一个切片）：内存命中，0 DB 查询
    await m.checkLlmBudget({ userId: 'u-cache', source: 'test-src' });
    expect(aggregateMock.mock.calls.length).toBe(callsAfterFirst);

    // 显式失效
    m.invalidateBudgetCache();

    // 再次调用：穿透回库执行聚合
    await m.checkLlmBudget({ userId: 'u-cache', source: 'test-src' });
    expect(aggregateMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
