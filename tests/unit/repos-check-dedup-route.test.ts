import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockCheckRepoDuplicates = vi.fn();
vi.mock('@/lib/repo-dedup', () => ({
  checkRepoDuplicates: (...args: unknown[]) => mockCheckRepoDuplicates(...args),
}));

const mockGetSession = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => mockGetSession(),
  getAdminUserHelper: () => mockGetSession(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/repos/check-dedup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/repos/check-dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('缺少 owner 或 repo 时返回 400', async () => {
    const { POST } = await import('@/app/api/repos/check-dedup/route');
    const res = await POST(makeRequest({ owner: 'karpathy' }));
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('有效参数时正确调用 checkRepoDuplicates 并返回 dedupInfo', async () => {
    mockCheckRepoDuplicates.mockResolvedValue({
      existsOnShelf: false,
      existsInExplore: true,
      existingRepo: { id: 'repo-1', owner: 'karpathy', repo: 'nanoGPT', gitSha: 'abc' },
      isFork: false,
      upstream: null,
      upstreamExistsInExplore: false,
      upstreamRepo: null,
    });

    const { POST } = await import('@/app/api/repos/check-dedup/route');
    const res = await POST(makeRequest({ owner: 'karpathy', repo: 'nanoGPT' }));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.dedupInfo.existsInExplore).toBe(true);
    expect(mockCheckRepoDuplicates).toHaveBeenCalledWith({
      owner: 'karpathy',
      repo: 'nanoGPT',
      userId: 'user-1',
      edition: '',
    });
  });

  it('未登录用户也能正常查重', async () => {
    mockGetSession.mockResolvedValue(null);
    mockCheckRepoDuplicates.mockResolvedValue({
      existsOnShelf: false,
      existsInExplore: false,
      existingRepo: null,
      isFork: false,
      upstream: null,
      upstreamExistsInExplore: false,
      upstreamRepo: null,
    });

    const { POST } = await import('@/app/api/repos/check-dedup/route');
    const res = await POST(makeRequest({ owner: 'new-owner', repo: 'new-repo' }));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.dedupInfo.existsInExplore).toBe(false);
    expect(mockCheckRepoDuplicates).toHaveBeenCalledWith({
      owner: 'new-owner',
      repo: 'new-repo',
      userId: undefined,
      edition: '',
    });
  });
});
