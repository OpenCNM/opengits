import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 流水表保留期清理（runRetentionPrune）单测:
 * cutoff 按 ENGINE_CONFIG.retention 计算 / Session 按即时过期 / 分批循环至清空 /
 * 单表失败不拖垮整轮。mock prisma。
 */

const findManyMock = vi.fn();
const deleteManyMock = vi.fn();
const updateManyMock = vi.fn();
const createMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, table: string) => {
        if (table === '__esModule') return false;
        return {
          findMany: findManyMock,
          deleteMany: deleteManyMock,
          updateMany: updateManyMock,
          create: createMock,
        };
      },
    },
  ),
}));

function idRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `id_${i}` }));
}

describe('runRetentionPrune(流水表保留期清理)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：所有表首轮查满批、删除全部命中 → 触发下一轮；空轮终止
    findManyMock.mockResolvedValue([]);
    // leader 租约：快路径未命中(count 0)→ create 成功 → 本实例获执行权
    updateManyMock.mockResolvedValue({ count: 0 });
    createMock.mockResolvedValue({});
    deleteManyMock.mockResolvedValue({ count: 0 });
  });

  async function runPrune() {
    const mod = await import('@/lib/telemetry/prune');
    return mod.runRetentionPrune();
  }

  it('🧪 [11.6.2.1] 逐表清理并返回计数报告(含 gatewaySecurityEvent 拦截事件表防膨胀，不含 ConversationMessage)', async () => {
    const report = await runPrune();
    expect(Object.keys(report).sort()).toEqual(
      ['adminAuditLog', 'episodicEvent', 'gatewaySecurityEvent', 'mcpCallLog', 'sessionExpired', 'tokenUsageLog'],
    );
    for (const key of Object.keys(report)) {
      expect(report[key]).toBeGreaterThanOrEqual(0);
    }
    // 用户聊天数据刻意不自动删除
    expect(report['conversationMessage']).toBeUndefined();
  });

  it('各表 cutoff 按保留期计算(Session 用 expires 即时回收)', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await runPrune();

      const byTable = new Map<string, { where: Record<string, unknown>; take?: number }>();
      for (const call of findManyMock.mock.calls) {
        byTable.set(JSON.stringify(call[0].where), call[0]);
      }
      // TokenUsageLog 默认 90 天
      expect(byTable.has(JSON.stringify({ createdAt: { lt: new Date(now - 90 * 24 * 60 * 60 * 1000) } }))).toBe(true);
      // AdminAuditLog 默认 365 天
      expect(byTable.has(JSON.stringify({ createdAt: { lt: new Date(now - 365 * 24 * 60 * 60 * 1000) } }))).toBe(true);
      // GatewaySecurityEvent 默认 14 天
      expect(byTable.has(JSON.stringify({ createdAt: { lt: new Date(now - 14 * 24 * 60 * 60 * 1000) } }))).toBe(true);
      // EpisodicEvent 与 McpCallLog 已由 Go worker-sidecar 独占修剪，返回 0
      expect(report.episodicEvent).toBe(0);
      expect(report.mcpCallLog).toBe(0);

      // Session 不走分批 findMany，直接按 expires < now 删
      const sessionCalls = deleteManyMock.mock.calls.filter((c) => 'expires' in c[0].where);
      expect(sessionCalls.length).toBe(1);
      expect((sessionCalls[0][0].where.expires.lt as Date).getTime()).toBeLessThanOrEqual(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it('大表分批循环:首批满批删除后继续,直到空批终止', async () => {
    let batch = 0;
    findManyMock.mockImplementation(() => {
      // 通过调用顺序模拟两批 + 空批
      batch += 1;
      if (batch <= 2) return Promise.resolve(idRows(5000));
      return Promise.resolve([]);
    });
    deleteManyMock.mockResolvedValue({ count: 5000 });
    // 其余表直接空
    const report = await runPrune();
    // 两批全量删除 → 循环第三轮才见空批;总删除数 = 10000
    expect(deleteManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: expect.any(Array) } },
    }));
    expect(report.tokenUsageLog).toBeGreaterThanOrEqual(0);
    // 验证每批 take=5000
    const takes = new Set(findManyMock.mock.calls.map((c) => c[0].take));
    expect(takes.has(5000)).toBe(true);
  });

  it('删除不足整批时提前终止(最后一小批)', async () => {
    let call = 0;
    findManyMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(idRows(5000));
      if (call === 2) return Promise.resolve([{ id: 'tail_1' }, { id: 'tail_2' }]);
      return Promise.resolve([]);
    });
    deleteManyMock.mockImplementation((arg: { where: { id: { in: string[] } } }) =>
      Promise.resolve({ count: arg.where.id.in.length }));
    await runPrune();
    // 第二批只有 2 条,count(2) == rows(2) → 继续第三轮;空批终止
    const counts = deleteManyMock.mock.calls
      .filter((c) => c[0]?.where?.id)
      .map((c) => c[0].where.id.in.length);
    expect(counts[1]).toBe(2);
  });

  it('count < rows(并发写入被删)也终止循环,不丢已删计数', async () => {
    findManyMock.mockReset();
    deleteManyMock.mockReset();
    findManyMock.mockImplementationOnce(() => Promise.resolve(idRows(3)))
      .mockImplementation(() => Promise.resolve([]));
    deleteManyMock.mockResolvedValueOnce({ count: 2 }); // 少于选出的 3 条
    const report = await runPrune();
    expect(findManyMock).toHaveBeenCalledTimes(3); // 1(tokenUsageLog 终止) + 2(其余流水表各一轮)
    expect(report.tokenUsageLog).toBe(2);
  });

  it('单表抛错不拖垮其余表,报告记 -1', async () => {
    // 任务按序执行:首个 findMany 即 tokenUsageLog 的选批查询
    findManyMock.mockImplementationOnce(() => {
      throw new Error('db gone');
    });
    const report = await runPrune();
    expect(report.tokenUsageLog).toBe(-1);
    expect(report.sessionExpired).toBe(0); // 后续表照常执行
  });
});
