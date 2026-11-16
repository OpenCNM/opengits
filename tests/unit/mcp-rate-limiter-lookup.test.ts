import { describe, expect, it, vi, beforeEach } from 'vitest';

const userFindUniqueMock = vi.fn();
const ledgerFindUniqueMock = vi.fn();
const ledgerUpsertMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    mcpUsageLedger: {
      findUnique: (...args: unknown[]) => ledgerFindUniqueMock(...args),
      upsert: (...args: unknown[]) => ledgerUpsertMock(...args),
    },
  },
}));

describe('McpRateLimiter Direct Key Optimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checkLimit: userId 走 id 主键索引直接查找', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      isBanned: false,
      mcpRpmLimit: 60,
      dailyMcpQuota: 200,
      singleCallTokenCap: 8000,
    });
    ledgerFindUniqueMock.mockResolvedValueOnce({ mcpCalls: 5 });

    const { McpRateLimiter } = await import('@/lib/mcp/rate-limiter');
    const res = await McpRateLimiter.checkLimit('user_cuid12345678', 'USER');

    expect(res.allowed).toBe(true);
    expect(userFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_cuid12345678' },
      })
    );
  });

  it('checkLimit: email 格式标识走 email 唯一索引查找', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      isBanned: false,
      mcpRpmLimit: 30,
      dailyMcpQuota: 100,
      singleCallTokenCap: 4000,
    });
    ledgerFindUniqueMock.mockResolvedValueOnce({ mcpCalls: 2 });

    const { McpRateLimiter } = await import('@/lib/mcp/rate-limiter');
    const res = await McpRateLimiter.checkLimit('test@example.com', 'USER');

    expect(res.allowed).toBe(true);
    expect(userFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'test@example.com' },
      })
    );
  });
});