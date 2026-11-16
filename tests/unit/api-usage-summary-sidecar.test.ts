import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

describe('GET /api/usage/summary (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callSummary() {
    const { GET } = await import('@/app/api/usage/summary/route');
    const request = new NextRequest('http://localhost/api/usage/summary', {
      method: 'GET',
    });
    return GET(request);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callSummary();
    expect(res.status).toBe(401);
  });

  it('用户在 sidecar 中不存在时返回 404 USER_NOT_FOUND', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-not-found' },
      expires: '2099-01-01',
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'USER_NOT_FOUND',
      error: 'User not found',
    });

    const res = await callSummary();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('正常返回用量与配额详情', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const mockSummary = {
      tier: 'PRO',
      isAdmin: true,
      reposUsed: 4,
      maxRepos: 0,
      mcpCallsToday: 20,
      dailyMcpCalls: 3000,
      tokens30d: 98000,
    };

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      summary: mockSummary,
    });

    const res = await callSummary();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: mockSummary });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/usage/summary',
      { userId: 'usr-123' },
      expect.objectContaining({ label: 'usage-summary /v1/usage/summary' })
    );
  });

  it('sidecar 故障时返回 500', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      error: 'database down',
    });

    const res = await callSummary();
    expect(res.status).toBe(500);
  });
});
