// request-guard 的 mcp-sidecar 配额跳过分支（Phase 2a）：
// - 带 x-mcp-quota-checked: 1 且 x-internal-token 签名有效 → 跳过限流/ledger（不双计数）
// - 头存在但令牌不匹配 → 照常走 McpRateLimiter（防伪造）
// - 鉴权在任何分支都照常执行（skip 只免计量，不免身份）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => {
  const { mockPrisma } = require('../helpers/mock-prisma');
  return { prisma: mockPrisma({}) };
});

const tokenAuth = vi.hoisted(() => ({
  authenticateMcpRequest: vi.fn(),
  getRoleForMcpUser: vi.fn(),
}));
vi.mock('@/lib/mcp/token-auth', () => tokenAuth);

const rateLimiter = vi.hoisted(() => ({ checkLimit: vi.fn() }));
vi.mock('@/lib/mcp/rate-limiter', () => ({ McpRateLimiter: rateLimiter }));

describe('enforceMcpAuthAndQuota sidecar quota-skip', () => {
  const INTERNAL_TOKEN = 'unit-internal-token';

  function makeRequest(headers: Record<string, string>): Request {
    return new Request('http://localhost/api/mcp/o/r', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
    }) as unknown as import('next/server').NextRequest;
  }

  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
    tokenAuth.authenticateMcpRequest.mockResolvedValue({ userId: 'u1', via: 'token' });
    tokenAuth.getRoleForMcpUser.mockResolvedValue('USER');
    rateLimiter.checkLimit.mockResolvedValue({ allowed: true, status: 200, headers: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('🧪 [7.8.2.2] skips McpRateLimiter when quota-checked header carries a valid internal token', async () => {
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');
    const result = await enforceMcpAuthAndQuota(makeRequest({
      'x-mcp-quota-checked': '1',
      'x-internal-token': INTERNAL_TOKEN,
    }), { rpc: true });

    expect(result.userId).toBe('u1');
    expect(result.response).toBeNull();
    expect(rateLimiter.checkLimit).not.toHaveBeenCalled();
  });

  it('🧪 [7.8.2.1] still meters when the internal token does not match (forged header)', async () => {
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');
    const result = await enforceMcpAuthAndQuota(makeRequest({
      'x-mcp-quota-checked': '1',
      'x-internal-token': 'attacker-guess',
    }), { rpc: true });

    expect(result.userId).toBe('u1');
    expect(rateLimiter.checkLimit).toHaveBeenCalledTimes(1);
  });

  it('🧪 [7.8.1.2] still meters when the header is absent (direct web-container traffic)', async () => {
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');
    await enforceMcpAuthAndQuota(makeRequest({}), { rpc: true });
    expect(rateLimiter.checkLimit).toHaveBeenCalledTimes(1);
  });

  it('🧪 [7.8.1.1] still rejects unauthenticated requests regardless of the skip header', async () => {
    tokenAuth.authenticateMcpRequest.mockResolvedValue({ userId: null, via: null });
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');
    const result = await enforceMcpAuthAndQuota(makeRequest({
      'x-mcp-quota-checked': '1',
      'x-internal-token': INTERNAL_TOKEN,
    }), { rpc: true });

    expect(result.userId).toBe('');
    expect(result.response?.status).toBe(401);
  });
});
