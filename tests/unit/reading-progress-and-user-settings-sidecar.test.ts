import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

describe('W1 Phase 5: Reading Progress & User Preferences Sidecar Offloading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/repositories/reading-progress/sync', () => {
    it('匿名用户直接返回空进度，不调用 sidecar', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const { GET } = await import('@/app/api/repositories/reading-progress/sync/route');
      const req = new NextRequest('http://localhost/api/repositories/reading-progress/sync?owner=fb&repo=react');
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        chapterScores: {},
        overallProgress: 0,
      });
      expect(callSidecarMock).not.toHaveBeenCalled();
    });

    it('缺少 owner 或 repo 返回 400', async () => {
      getSessionHelperMock.mockResolvedValue({ user: { id: 'u1' } });
      const { GET } = await import('@/app/api/repositories/reading-progress/sync/route');
      const req = new NextRequest('http://localhost/api/repositories/reading-progress/sync?owner=fb');
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it('登录用户成功委托调用 Go sidecar', async () => {
      getSessionHelperMock.mockResolvedValue({ user: { id: 'u1' } });
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        chapterScores: { 'ch1.md': 85 },
        overallProgress: 85,
        viewedCount: 1,
      });

      const { GET } = await import('@/app/api/repositories/reading-progress/sync/route');
      const req = new NextRequest('http://localhost/api/repositories/reading-progress/sync?owner=fb&repo=react&edition=v2');
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        chapterScores: { 'ch1.md': 85 },
        overallProgress: 85,
        viewedCount: 1,
      });
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/reading/progress-sync',
        {
          userId: 'u1',
          owner: 'fb',
          repo: 'react',
          edition: 'v2',
        },
        expect.objectContaining({ label: 'reading /v1/reading/progress-sync' })
      );
    });
  });

  describe('GET /api/user/preferences', () => {
    it('未登录返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const { GET } = await import('@/app/api/user/preferences/route');
      const req = new NextRequest('http://localhost/api/user/preferences');
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it('登录态正确委托 sidecar 并返回书架仓概览', async () => {
      getSessionHelperMock.mockResolvedValue({ user: { id: 'u1' } });
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        preferences: {
          hasPreferencesSet: true,
          fontSize: 'small',
          disabledMcpRepoIds: [],
          savedRepositories: [
            {
              id: 'r1',
              owner: 'vuejs',
              repo: 'core',
              mcpStatus: 'ACTIVE',
              totalDocs: 5,
              processedDocs: 5,
              isProcessed: true,
              progress: 100,
            },
          ],
        },
      });

      const { GET } = await import('@/app/api/user/preferences/route');
      const req = new NextRequest('http://localhost/api/user/preferences');
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.savedRepositories).toHaveLength(1);
      expect(json.data.savedRepositories[0].repo).toBe('core');
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/user/preferences/get',
        { userId: 'u1' },
        expect.objectContaining({ label: 'user-preferences /v1/user/preferences/get' })
      );
    });
  });
});
