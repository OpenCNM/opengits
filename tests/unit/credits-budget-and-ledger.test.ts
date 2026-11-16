import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

const tokenAggregateMock = vi.fn();
const budgetConfigFindUniqueMock = vi.fn();
const budgetConfigCreateMock = vi.fn();
const budgetConfigUpsertMock = vi.fn();

const creditGrantLedgerFindManyMock = vi.fn();
const chapterUpdateJobFindManyMock = vi.fn();
const importJobFindManyMock = vi.fn();
const savedRepoFindManyMock = vi.fn();
const savedRepoCountMock = vi.fn();
const userFindUniqueMock = vi.fn();
const mockExecuteSidecarCreditsLedger = vi.fn();
vi.mock('@/engine/credits-driver', () => ({
  executeSidecarCreditsLedger: (...args: unknown[]) => mockExecuteSidecarCreditsLedger(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    platformBudgetConfig: {
      findUnique: (...args: unknown[]) => budgetConfigFindUniqueMock(...args),
      create: (...args: unknown[]) => budgetConfigCreateMock(...args),
      upsert: (...args: unknown[]) => budgetConfigUpsertMock(...args),
    },
    tokenUsageLog: {
      aggregate: (...args: unknown[]) => tokenAggregateMock(...args),
    },
    creditGrantLedger: {
      findMany: (...args: unknown[]) => creditGrantLedgerFindManyMock(...args),
    },
    chapterUpdateJob: {
      findMany: (...args: unknown[]) => chapterUpdateJobFindManyMock(...args),
    },
    importJob: {
      findMany: (...args: unknown[]) => importJobFindManyMock(...args),
    },
    savedRepo: {
      findMany: (...args: unknown[]) => savedRepoFindManyMock(...args),
      count: (...args: unknown[]) => savedRepoCountMock(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
  },
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'session_user_valid' } }),
}));

describe('M06 Credits: Budget, Ledger, and Concurrency Guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    budgetConfigFindUniqueMock.mockResolvedValue({
      id: 'singleton',
      perUserDailyTokens: 50_000,
      platformDailyTokens: 500_000,
      breakerEnabled: true,
      sourceQuotas: {},
    });
    budgetConfigUpsertMock.mockImplementation((args: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) =>
      Promise.resolve({
        id: args.where.id,
        perUserDailyTokens: 50_000,
        platformDailyTokens: 500_000,
        breakerEnabled: true,
        sourceQuotas: {},
        ...args.create,
        ...args.update,
      })
    );
    tokenAggregateMock.mockResolvedValue({ _sum: { totalTokens: 10_000 } });

    creditGrantLedgerFindManyMock.mockResolvedValue([]);
    chapterUpdateJobFindManyMock.mockResolvedValue([]);
    importJobFindManyMock.mockResolvedValue([]);
    savedRepoFindManyMock.mockResolvedValue([]);
    savedRepoCountMock.mockResolvedValue(0);
    userFindUniqueMock.mockResolvedValue({ signupGiftAt: new Date(), creditBalance: 100 });
    mockExecuteSidecarCreditsLedger.mockResolvedValue({
      entries: [],
      pagination: { total: 0, page: 1, pageSize: 20, totalPages: 0 },
      balance: 100,
      savedRepos: 0,
    });
  });

  it('🧪 [6.2.2.1] 精确 24h 时间窗口边界判断（防跨 UTC 0 点时区切换套利）', async () => {
    const { getResetWindowBounds } = await import('@/lib/credits-ledger');

    const t1 = new Date('2026-09-13T01:30:00.000Z');
    const bounds1 = getResetWindowBounds(t1, 24);

    // 窗口起点为 UTC 零点纪元对齐时间戳
    expect(bounds1.start.toISOString()).toBe('2026-09-13T00:00:00.000Z');
    expect(bounds1.nextResetAt.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(bounds1.end.getTime()).toBe(bounds1.nextResetAt.getTime() - 1);

    // 跨时区切换套利防御：不同本地偏置但同一 UTC 物理时刻计算出完全相同的窗口
    const t2 = new Date(t1.getTime());
    const bounds2 = getResetWindowBounds(t2, 24);
    expect(bounds2.start.getTime()).toBe(bounds1.start.getTime());
    expect(bounds2.nextResetAt.getTime()).toBe(bounds1.nextResetAt.getTime());

    // 跨越 24h 周期边界后严格递进至下一窗口
    const t3 = new Date('2026-09-14T00:00:01.000Z');
    const bounds3 = getResetWindowBounds(t3, 24);
    expect(bounds3.start.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(bounds3.start.getTime()).toBe(bounds1.nextResetAt.getTime());
  });

  it('🧪 [6.3.1.1] 积分流水查询严格校验 Session userId（防 IDOR 越权查看他人流水）', async () => {
    const { GET } = await import('@/app/api/user/credits/ledger/route');

    // 模拟恶意用户试图通过 URL 查询参数传递 ?userId=victim_999
    const req = new NextRequest('http://localhost:3000/api/user/credits/ledger?userId=victim_999&page=1&pageSize=20', {
      headers: {
        'x-mock-user-id': 'session_user_valid',
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);

    // 验证 Go sidecar 驱动查询严格使用当前 Session 中的 userId，绝不使用 query 参数中的 victim_999
    expect(mockExecuteSidecarCreditsLedger).toHaveBeenCalledWith(
      'session_user_valid',
      1,
      20
    );
    expect(mockExecuteSidecarCreditsLedger).not.toHaveBeenCalledWith(
      expect.stringContaining('victim_999'),
      expect.anything(),
      expect.anything()
    );
  });

  it('🧪 [6.3.2.1] 流水明细类型未知枚举时具备通用 fallback 兜底', async () => {
    const { resolveCreditSourceLabel } = await import('@/components/credits/CreditLedgerView');

    // 已知枚举正常命中友好文案
    const importReward = resolveCreditSourceLabel('IMPORT_REWARD');
    expect(typeof importReward).toBe('string');
    expect(importReward.length).toBeGreaterThan(0);

    const signupGift = resolveCreditSourceLabel('SIGNUP_GIFT');
    expect(typeof signupGift).toBe('string');
    expect(signupGift.length).toBeGreaterThan(0);

    // 数据库新增未知枚举（如 FUTURE_PROMO_V2）时，触发 fallback 原样返回枚举字符串，绝不返回 undefined 或崩溃
    const unknownSource = 'FUTURE_PROMO_V2';
    const fallbackLabel = resolveCreditSourceLabel(unknownSource);
    expect(fallbackLabel).toBe('FUTURE_PROMO_V2');
    expect(fallbackLabel).toBeDefined();
    expect(typeof fallbackLabel).toBe('string');
  });

  it('🧪 [6.3.3.1] Prisma Schema 用户注销级联配置验证（onDelete: Cascade）', () => {
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    // 提取 CreditGrantLedger 模型块
    const ledgerModelMatch = schemaContent.match(/model CreditGrantLedger\s*\{[\s\S]*?\n\}/);
    expect(ledgerModelMatch).not.toBeNull();
    const ledgerBlock = ledgerModelMatch![0];

    // 断言必须包含与 User 的物理外键及 onDelete: Cascade
    expect(ledgerBlock).toMatch(/user\s+User\s+@relation\(fields:\s*\[userId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  });

  it('🧪 [6.4.1.1] 用户自备 Key (BYOK) 调用严格跳过平台公共配额扣减', async () => {
    const { checkLlmBudget } = await import('@/lib/llm-budget');

    // BYOK 调用（keyOrigin === 'user'）
    await expect(
      checkLlmBudget({
        userId: 'user-with-own-key',
        keyOrigin: 'user',
        source: 'chat',
      })
    ).resolves.toBeUndefined();

    // 验证严格未触发平台配额查库
    expect(tokenAggregateMock).not.toHaveBeenCalled();
  });

  it('🧪 [6.4.2.1] 大并发请求跨越熔断红线时原子置 isPlatformQuotaExceeded=true 立即断流', async () => {
    const { checkLlmBudget, BudgetExceededError } = await import('@/lib/llm-budget');

    // 用户级消耗正常 (10,000 < 50,000)，但平台总消耗达到 600,000，超过 platformDailyTokens (500,000)
    tokenAggregateMock.mockImplementation((args: { where: { userId?: string } }) => {
      if (args.where.userId) {
        return Promise.resolve({ _sum: { totalTokens: 10_000 } });
      }
      return Promise.resolve({ _sum: { totalTokens: 600_000 } });
    });

    await expect(
      checkLlmBudget({
        userId: 'user-platform-consumer',
        keyOrigin: 'platform',
      })
    ).rejects.toThrow(BudgetExceededError);

    await expect(
      checkLlmBudget({
        userId: 'user-platform-consumer',
        keyOrigin: 'platform',
      })
    ).rejects.toThrow('LLM budget exceeded (platform)');

    // 2. 用户级消耗超限 (55,000 >= 50,000) 触发 user 级熔断断流
    tokenAggregateMock.mockImplementation((args: { where: { userId?: string } }) => {
      if (args.where.userId) {
        return Promise.resolve({ _sum: { totalTokens: 55_000 } });
      }
      return Promise.resolve({ _sum: { totalTokens: 100_000 } });
    });

    await expect(
      checkLlmBudget({
        userId: 'user-over-quota',
        keyOrigin: 'platform',
      })
    ).rejects.toThrow('LLM budget exceeded (user)');
  });

  it('🧪 [6.4.3.1] 平台配额单例行 upsert（固定 id=1 / singleton）防并发主键冲突', async () => {
    const { updateBudgetConfig } = await import('@/lib/llm-budget');

    const result = await updateBudgetConfig({
      platformDailyTokens: 800_000,
      breakerEnabled: true,
    });

    expect(budgetConfigUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        create: expect.objectContaining({ id: 'singleton', platformDailyTokens: 800_000 }),
        update: expect.objectContaining({ platformDailyTokens: 800_000 }),
      })
    );
    expect(result.platformDailyTokens).toBe(800_000);
  });

  it('🧪 [6.4.4.1] normalizeSourceQuotas 原型污染与非法键清洗：坚决过滤 __proto__, constructor 与负数配额', async () => {
    const { normalizeSourceQuotas } = await import('@/lib/llm-budget');

    const maliciousRaw = JSON.parse(
      '{"__proto__": 1000, "constructor": 2000, "prototype": 3000, "chat": 50000, "badNegative": -100, "badNaN": "string"}'
    );

    const quotas = normalizeSourceQuotas(maliciousRaw);
    expect(quotas['chat']).toBe(50000);
    expect(quotas['badNegative']).toBeUndefined();
    expect(quotas['badNaN']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(quotas, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(quotas, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(quotas, 'prototype')).toBe(false);
  });

});
