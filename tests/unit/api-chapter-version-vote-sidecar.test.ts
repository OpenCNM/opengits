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

const maybeFlipCanonicalMock = vi.fn();
vi.mock('@/lib/update-market/versions', () => ({
  maybeFlipCanonical: (...args: unknown[]) => maybeFlipCanonicalMock(...args),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

describe('POST /api/chapter-versions/[id]/vote (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    checkRateLimitMock.mockResolvedValue(true);
    maybeFlipCanonicalMock.mockResolvedValue({ flipped: false });
    callSidecarMock.mockResolvedValue({
      ok: true,
      voted: true,
      voteCount: 5,
      documentId: 'doc-1',
    });
  });

  async function callVote(id: string) {
    const { POST } = await import('@/app/api/chapter-versions/[id]/vote/route');
    const request = new NextRequest(`http://localhost/api/chapter-versions/${id}/vote`, {
      method: 'POST',
    });
    return POST(request, { params: Promise.resolve({ id }) });
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callVote('v1');
    expect(res.status).toBe(401);
  });

  it('频率超限时返回 429', async () => {
    checkRateLimitMock.mockResolvedValue(false);
    const res = await callVote('v1');
    expect(res.status).toBe(429);
  });

  it('版本不存在时返回 404', async () => {
    callSidecarMock.mockResolvedValue({ ok: false, notFound: true });
    const res = await callVote('non-existent');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('NOT_FOUND');
  });

  it('无权限时返回 403', async () => {
    callSidecarMock.mockResolvedValue({ ok: false, forbidden: true });
    const res = await callVote('v-private');
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('FORBIDDEN');
  });

  it('私有版本投票时返回 409 (INVALID_STATE)', async () => {
    callSidecarMock.mockResolvedValue({ ok: false, invalidState: true });
    const res = await callVote('v-draft');
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('INVALID_STATE');
  });

  it('为自己的版本投票时返回 409 (SELF_VOTE)', async () => {
    callSidecarMock.mockResolvedValue({ ok: false, selfVote: true });
    const res = await callVote('v-mine');
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('SELF_VOTE');
  });

  it('投票成功时下沉至 sidecar 并触发 maybeFlipCanonical 判定', async () => {
    maybeFlipCanonicalMock.mockResolvedValue({ flipped: true, canonicalVersionId: 'v1' });
    const res = await callVote('v1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      voted: true,
      voteCount: 5,
      canonicalChanged: true,
    });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/vote',
      { versionId: 'v1', userId: 'user-1' },
      expect.objectContaining({ label: 'chapter-versions-vote /v1/chapter-versions/vote' })
    );
    expect(maybeFlipCanonicalMock).toHaveBeenCalledWith('doc-1');
  });
});
