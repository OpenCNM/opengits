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

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

describe('POST /api/repos/[owner]/view (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callSidecarMock.mockResolvedValue({ ok: true });
  });

  async function callView(params: { owner?: string; id?: string }) {
    const { POST } = await import('@/app/api/repos/[owner]/view/route');
    const request = new NextRequest('http://localhost/api/repos/repo-1/view', {
      method: 'POST',
    });
    return POST(request, { params: Promise.resolve(params) });
  }

  it('缺少 repositoryId 时返回 400', async () => {
    const res = await callView({});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('有效 repositoryId 下沉至 sidecar /v1/repos/view', async () => {
    const res = await callView({ owner: 'repo-abc' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, data: {} });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/view',
      { repositoryId: 'repo-abc' },
      expect.objectContaining({ label: 'repos-view /v1/repos/view' })
    );
  });

  it('Sidecar 异常时 fire-and-forget 静默返回 200', async () => {
    callSidecarMock.mockRejectedValue(new Error('connection refused'));
    const res = await callView({ id: 'repo-xyz' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, data: {} });
  });
});

describe('POST /api/repositories/pin (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-42' } });
    callSidecarMock.mockResolvedValue({ ok: true, pinnedRepoIds: ['repo-123'] });
  });

  async function callPin(body?: unknown) {
    const { POST } = await import('@/app/api/repositories/pin/route');
    const request = new NextRequest('http://localhost/api/repositories/pin', {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    });
    return POST(request, { params: Promise.resolve({}) });
  }

  it('未登录返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callPin({ repositoryId: 'repo-123' });
    expect(res.status).toBe(401);
  });

  it('非法的请求体返回 400', async () => {
    const res = await callPin({ repositoryId: '' });
    expect(res.status).toBe(400);
  });

  it('置顶成功下沉至 sidecar /v1/user/pin 并返回新数组', async () => {
    const res = await callPin({ repositoryId: 'repo-123', isPinned: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      data: { pinnedRepoIds: ['repo-123'] },
    });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/user/pin',
      { userId: 'user-42', repositoryId: 'repo-123', isPinned: true },
      expect.objectContaining({ label: 'user-pin /v1/user/pin' })
    );
  });
});
