import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

const mockGetSession = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => mockGetSession(),
  getAdminUserHelper: () => mockGetSession(),
}));

const mockCachedRepo = vi.fn();
vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  cachedDefaultBranchRepository: (...args: unknown[]) => mockCachedRepo(...args),
}));

const mockVerifyAccess = vi.fn();
vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: (...args: unknown[]) => mockVerifyAccess(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
}));

function makeHelpfulRequest(owner: string, repoQuery?: string): NextRequest {
  const url = repoQuery
    ? `http://localhost:3000/api/repos/${owner}/helpful?repo=${encodeURIComponent(repoQuery)}`
    : `http://localhost:3000/api/repos/${owner}/helpful`;
  return new NextRequest(url, { method: 'POST' });
}

describe('POST /api/repos/[owner]/helpful (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCachedRepo.mockResolvedValue({ id: 'repo-10', isPublic: true });
    mockVerifyAccess.mockResolvedValue(true);
    mockCallSidecar.mockResolvedValue({ ok: true, voted: true, helpfulCount: 42 });
  });

  it('未登录返回 401', async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/repos/[owner]/helpful/route');
    const res = await POST(makeHelpfulRequest('owner-1', 'myrepo'), {
      params: Promise.resolve({ owner: 'owner-1' }),
    });
    expect(res.status).toBe(401);
  });

  it('缺少 repo 查询参数返回 400', async () => {
    const { POST } = await import('@/app/api/repos/[owner]/helpful/route');
    const res = await POST(makeHelpfulRequest('owner-1'), {
      params: Promise.resolve({ owner: 'owner-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('仓库不存在返回 404', async () => {
    mockCachedRepo.mockResolvedValue(null);
    const { POST } = await import('@/app/api/repos/[owner]/helpful/route');
    const res = await POST(makeHelpfulRequest('owner-1', 'ghost-repo'), {
      params: Promise.resolve({ owner: 'owner-1' }),
    });
    expect(res.status).toBe(404);
  });

  it('无权限访问返回 403', async () => {
    mockVerifyAccess.mockResolvedValue(false);
    const { POST } = await import('@/app/api/repos/[owner]/helpful/route');
    const res = await POST(makeHelpfulRequest('owner-1', 'private-repo'), {
      params: Promise.resolve({ owner: 'owner-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('点赞成功下沉至 sidecar 并返回投票态和计数值', async () => {
    const { POST } = await import('@/app/api/repos/[owner]/helpful/route');
    const res = await POST(makeHelpfulRequest('owner-1', 'myrepo'), {
      params: Promise.resolve({ owner: 'owner-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ voted: true, helpfulCount: 42 });
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/repos/helpful',
      { repositoryId: 'repo-10', userId: 'user-1' },
      expect.objectContaining({ label: 'repos-helpful /v1/repos/helpful' })
    );
  });
});
