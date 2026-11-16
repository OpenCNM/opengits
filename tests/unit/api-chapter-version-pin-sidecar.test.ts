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

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue({ role: null }) },
  },
}));

describe('POST /api/chapter-versions/[id]/pin (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'usr-1' } });
    checkRateLimitMock.mockResolvedValue(true);
  });

  async function callPin(id: string) {
    const { POST } = await import('@/app/api/chapter-versions/[id]/pin/route');
    const req = new NextRequest(`http://localhost/api/chapter-versions/${id}/pin`, { method: 'POST' });
    return POST(req, { params: Promise.resolve({ id }) });
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callPin('v-1');
    expect(res.status).toBe(401);
  });

  it('频控触发时返回 429', async () => {
    checkRateLimitMock.mockResolvedValue(false);
    const res = await callPin('v-1');
    expect(res.status).toBe(429);
  });

  it('版本不存在时返回 404', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      notFound: true,
      error: 'version not found',
    });

    const res = await callPin('v-missing');
    expect(res.status).toBe(404);
  });

  it('非维护者置顶时返回 403', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      forbidden: true,
      error: 'forbidden',
    });

    const res = await callPin('v-1');
    expect(res.status).toBe(403);
  });

  it('维护者成功置顶正典', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      success: true,
      flipped: true,
      documentId: 'doc-1',
    });

    const res = await callPin('v-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { success: true },
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/pin',
      expect.objectContaining({
        versionId: 'v-1',
        userId: 'usr-1',
      }),
      expect.anything()
    );
  });
});
