import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue(null),
}));

function makeSearchRequest(query?: string): NextRequest {
  const url = query !== undefined
    ? `http://localhost:3000/api/search?q=${encodeURIComponent(query)}`
    : `http://localhost:3000/api/search`;
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/search empty query (Go sidecar featured tutorials offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空查询时调用 Sidecar /v1/search/featured 并返回 featured_tutorial 项', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: true,
      repos: [
        { id: 'repo-1', owner: 'facebook', repo: 'react' },
        { id: 'repo-2', owner: 'vercel', repo: 'next.js' },
      ],
    });

    const { GET } = await import('@/app/api/search/route');
    const res = await GET(makeSearchRequest(''));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);

    expect(body.data[0]).toEqual({
      id: 'featured-repo-1',
      type: 'featured_tutorial',
      isIngested: true,
      title: 'facebook/react',
      description: '',
      owner: 'facebook',
      repo: 'react',
      url: '/docs/facebook/react',
      score: 0,
    });

    expect(body.data[1]).toEqual({
      id: 'featured-repo-2',
      type: 'featured_tutorial',
      isIngested: true,
      title: 'vercel/next.js',
      description: '',
      owner: 'vercel',
      repo: 'next.js',
      url: '/docs/vercel/next.js',
      score: 0,
    });

    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/search/featured',
      expect.objectContaining({ limit: expect.any(Number) }),
      expect.anything()
    );
  });

  it('Sidecar 异常时优雅降级返回空数组，不导致接口崩溃', async () => {
    mockCallSidecar.mockRejectedValue(new Error('sidecar timeout'));

    const { GET } = await import('@/app/api/search/route');
    const res = await GET(makeSearchRequest(''));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});
