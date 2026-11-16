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

describe('GET /api/chapter-versions (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGetVersions(url: string) {
    const { GET } = await import('@/app/api/chapter-versions/route');
    const req = new NextRequest(url, { method: 'GET' });
    return GET(req);
  }

  it('缺少 documentId 时返回 400', async () => {
    const res = await callGetVersions('http://localhost/api/chapter-versions');
    expect(res.status).toBe(400);
  });

  it('正常拉取章节版本列表', async () => {
    const mockVersions = [
      {
        id: 'ver-1',
        authorId: 'usr-1',
        voteCount: 12,
        isCanonical: true,
        visibility: 'PUBLIC',
        source: 'ORIGINAL',
        createdAt: '2026-09-21T00:00:00Z',
        author: { name: 'Alice', image: null },
        hasVoted: false,
        isContentValid: true,
      },
    ];

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      versions: mockVersions,
    });

    const res = await callGetVersions('http://localhost/api/chapter-versions?documentId=doc-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { versions: mockVersions },
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/list',
      { documentId: 'doc-1', userId: undefined },
      expect.objectContaining({ label: 'chapter-versions /v1/chapter-versions/list' })
    );
  });

  it('sidecar 故障时返回 500', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      error: 'store failure',
    });

    const res = await callGetVersions('http://localhost/api/chapter-versions?documentId=doc-err');
    expect(res.status).toBe(500);
  });
});
