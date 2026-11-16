import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChapterMeta, RawTelemetryEvent } from '@/engine/reading-fingerprint/types';

/**
 * 阅读指纹 driver（Unit 3.6）Fail-Closed 单实现测试（2026-09-11 收刀）：
 * - 本地 TS 纯函数已物理删除——sidecar 离线/畸形载荷必须显式抛错，绝不静默回退；
 * - 在线时透传 Go 端结果，携带 x-internal-token 鉴权头，契约由冻结夹具锁定。
 */

describe('Fingerprint Driver (Fail-Closed Single Implementation)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const chapters: ChapterMeta[] = [
    { path: 'guide.md', wordCount: 600, codeBlockCount: 3, headingCount: 5, pageUrl: '/docs/o/r/guide' },
    { path: 'tiny.md', wordCount: 100, codeBlockCount: 0, headingCount: 2, pageUrl: '/docs/o/r/tiny' },
  ];

  const events: RawTelemetryEvent[] = [
    { eventType: 'PAGE_VIEW', pageUrl: '/docs/o/r/guide', duration: 30000, createdAt: new Date('2026-09-01T10:00:00Z'), metadata: { scrollPercent: 95 } },
    { eventType: 'PAGE_VIEW', pageUrl: '/docs/o/r/tiny', duration: 2000, createdAt: new Date('2026-09-01T10:05:00Z'), metadata: null },
  ];

  describe('Batch Computing (computeReadingFingerprintBatchViaSidecar)', () => {
    it('空列表直接返回空对象且不发起网络请求', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { computeReadingFingerprintBatchViaSidecar } = await import('@/engine/fingerprint-driver');
      const result = await computeReadingFingerprintBatchViaSidecar([]);
      expect(result).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sidecar 离线时显式抛 SidecarError', async () => {
      const { computeReadingFingerprintBatchViaSidecar } = await import('@/engine/fingerprint-driver');
      await expect(
        computeReadingFingerprintBatchViaSidecar([{ repoId: 'r1', chapters, events }])
      ).rejects.toThrow(/sidecar unreachable|not configured/);
    });

    it('sidecar 在线时单次 POST /v1/fingerprint/compute-batch 并返回各仓结果', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';

      const mockProgress = {
        overallProgress: 80,
        chapterScores: [
          { path: 'guide.md', score: 80, breakdown: { scrollProgress: 80, timeProgress: 80 }, contentWeight: 1.0, visitCount: 1, totalDwellMs: 20000 },
        ],
        totalChapters: 1,
        effectivelyRead: 1,
        summary: { avgScore: 80, maxScore: 80, minScore: 80 },
      };

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          results: {
            'repo-alpha': mockProgress,
          },
        }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { computeReadingFingerprintBatchViaSidecar } = await import('@/engine/fingerprint-driver');
      const got = await computeReadingFingerprintBatchViaSidecar([
        { repoId: 'repo-alpha', chapters, events },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('/v1/fingerprint/compute-batch');
      expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
      expect(got).toEqual({ 'repo-alpha': mockProgress });
    });

    it('sidecar 返回畸形载荷时显式抛错', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, results: null }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { computeReadingFingerprintBatchViaSidecar } = await import('@/engine/fingerprint-driver');
      await expect(
        computeReadingFingerprintBatchViaSidecar([{ repoId: 'r1', chapters, events }])
      ).rejects.toThrow(/malformed result payload/);
    });
  });
});
