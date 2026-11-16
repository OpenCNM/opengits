import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandSearchQuery } from '@/lib/mcp/tools/search';

const prismaMock = vi.hoisted(() => ({
  globalConcept: { findMany: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/telemetry/mcp-beacon', () => ({
  recordMcpToolCall: vi.fn(async () => {}),
  recordMcpToolError: vi.fn(async () => {}),
}));

describe('GlobalConcept.aliases 受控查询扩展', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('token 命中词表时并入 canonicalName 与别名', async () => {
    prismaMock.globalConcept.findMany.mockResolvedValue([
      { canonicalName: 'Concurrency', aliases: ['并发编程', 'concurrent'] },
    ]);
    const { keywords, aliasSources } = await expandSearchQuery('锁与并发 竞态');
    expect(keywords).toContain('Concurrency');
    expect(keywords).toContain('并发编程');
    expect(aliasSources).toContain('"Concurrency"');
    // 主查询语义保持原文
    const { expandedQuery } = await expandSearchQuery('锁与并发 竞态');
    expect(expandedQuery).toBe('锁与并发 竞态');
  });

  it('无命中/DB 故障时零注入（静默降级不阻塞检索）', async () => {
    prismaMock.globalConcept.findMany.mockRejectedValue(new Error('db down'));
    const { keywords, aliasSources } = await expandSearchQuery('lock-free queue');
    expect(aliasSources).toEqual([]);
    expect(keywords).toEqual(['lock-free', 'queue']);
  });

  it('扩展词不回环重复基础 token', async () => {
    prismaMock.globalConcept.findMany.mockResolvedValue([
      { canonicalName: 'queue', aliases: ['队列'] },
    ]);
    const { keywords } = await expandSearchQuery('queue design');
    expect(keywords.filter((k) => k === 'queue')).toHaveLength(1);
    expect(keywords).toContain('队列');
  });
});
