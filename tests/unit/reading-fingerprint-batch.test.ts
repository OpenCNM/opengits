import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeProgressBatch } from '@/lib/reading-fingerprint-adapter';
import * as fingerprintDriver from '@/engine/fingerprint-driver';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    episodicEvent: {
      findMany: vi.fn(),
    },
    userReadingProgress: {
      findMany: vi.fn(),
    },
    tutorialOutline: {
      findMany: vi.fn(),
    },
  },
}));

describe('Reading Fingerprint Batch Computing (computeProgressBatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.episodicEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.userReadingProgress.findMany).mockResolvedValue([]);
      vi.mocked(prisma.tutorialOutline.findMany).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🧪 [3.6.1.5 · HIGH] 空仓库列表前置彻底短路，不执行任何 DB 查询', async () => {
    const result = await computeProgressBatch('user-123', []);
    expect(result).toEqual({});
    expect(prisma.episodicEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.userReadingProgress.findMany).not.toHaveBeenCalled();
  });

  it('未登录用户（空 userId）为各仓返回零进度且不查询事件流', async () => {
    const repos = [
      { id: 'repo-1', owner: 'org', repo: 'app', docs: [{ path: 'readme.md' }] },
      { id: 'repo-2', owner: 'org', repo: 'web', docs: [{ path: 'guide.md' }] },
    ];
    const result = await computeProgressBatch('', repos);
    expect(result).toEqual({
      'repo-1': { progress: 0, viewedCount: 0, lastReadPath: null, lastReadAt: null, chapterScores: {} },
      'repo-2': { progress: 0, viewedCount: 0, lastReadPath: null, lastReadAt: null, chapterScores: {} },
    });
    expect(prisma.episodicEvent.findMany).not.toHaveBeenCalled();
  });

  it('🧪 [3.6.1.5 · HIGH] 多仓场景仅发起单次批量计算 RPC 往返，消解串行网络风暴', async () => {
    const repos = [
      { id: 'repo-1', owner: 'org', repo: 'app', docs: [{ path: 'readme.md' }] },
      { id: 'repo-2', owner: 'org', repo: 'web', docs: [{ path: 'guide.md' }] },
    ];

    vi.mocked(prisma.episodicEvent.findMany).mockResolvedValue([
      {
        eventType: 'PAGE_VIEW',
        pageUrl: '/docs/org/app',
        targetId: null,
        duration: 30000,
        createdAt: new Date(),
        metadata: null,
      },
      {
        eventType: 'PAGE_VIEW',
        pageUrl: '/docs/org/web/guide',
        targetId: null,
        duration: 45000,
        createdAt: new Date(),
        metadata: null,
      },
    ] as any);

    const batchSpy = vi.spyOn(fingerprintDriver, 'computeReadingFingerprintBatchViaSidecar').mockResolvedValue({
      'repo-1': {
        overallProgress: 100,
        totalChapters: 1,
        effectivelyRead: 1,
        chapterScores: [{ path: 'readme.md', score: 100, breakdown: { scrollProgress: 100, timeProgress: 100 }, contentWeight: 1, visitCount: 1, totalDwellMs: 30000 }],
        summary: { avgScore: 100, maxScore: 100, minScore: 100 },
      },
      'repo-2': {
        overallProgress: 80,
        totalChapters: 1,
        effectivelyRead: 1,
        chapterScores: [{ path: 'guide.md', score: 80, breakdown: { scrollProgress: 80, timeProgress: 80 }, contentWeight: 1, visitCount: 1, totalDwellMs: 45000 }],
        summary: { avgScore: 80, maxScore: 80, minScore: 80 },
      },
    });

    const result = await computeProgressBatch('user-1', repos);

    // 严禁在循环内发起多次串行调用，必须且仅能发起单次批量调用
    expect(batchSpy).toHaveBeenCalledOnce();
    const batchItems = batchSpy.mock.calls[0][0];
    expect(batchItems).toHaveLength(2);
    expect(batchItems[0].repoId).toBe('repo-1');
    expect(batchItems[1].repoId).toBe('repo-2');

    expect(result['repo-1'].progress).toBe(100);
    expect(result['repo-1'].viewedCount).toBe(1);
    expect(result['repo-1'].chapterScores).toEqual({ 'readme.md': 100 });

    expect(result['repo-2'].progress).toBe(80);
    expect(result['repo-2'].viewedCount).toBe(1);
    expect(result['repo-2'].chapterScores).toEqual({ 'guide.md': 80 });
  });

  it('Sidecar 批量计算失败时优雅降级（兜底返回零进度，不阻断页面渲染）', async () => {
    const repos = [
      { id: 'repo-1', owner: 'org', repo: 'app', docs: [{ path: 'readme.md' }] },
    ];

    vi.spyOn(fingerprintDriver, 'computeReadingFingerprintBatchViaSidecar').mockRejectedValue(
      new Error('sidecar down')
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await computeProgressBatch('user-1', repos);

    expect(result['repo-1'].progress).toBe(0);
    expect(result['repo-1'].viewedCount).toBe(0);
    expect(result['repo-1'].chapterScores).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it('仓库名存在前缀包含关系时严格按边界隔离事件（防止 org/app 吞没 org/app-pro 的事件）', async () => {
    const repos = [
      { id: 'repo-short', owner: 'org', repo: 'app', docs: [{ path: 'readme.md' }] },
      { id: 'repo-long', owner: 'org', repo: 'app-pro', docs: [{ path: 'readme.md' }] },
    ];

    vi.mocked(prisma.episodicEvent.findMany).mockResolvedValue([
      {
        eventType: 'PAGE_VIEW',
        pageUrl: '/docs/org/app-pro/readme',
        targetId: null,
        duration: 30000,
        createdAt: new Date(),
        metadata: null,
      },
    ] as any);

    const batchSpy = vi.spyOn(fingerprintDriver, 'computeReadingFingerprintBatchViaSidecar').mockResolvedValue({
      'repo-short': {
        overallProgress: 0,
        totalChapters: 1,
        effectivelyRead: 0,
        chapterScores: [],
      },
      'repo-long': {
        overallProgress: 100,
        totalChapters: 1,
        effectivelyRead: 1,
        chapterScores: [{ path: 'readme.md', score: 100, breakdown: { scrollProgress: 100, timeProgress: 100 }, contentWeight: 1, visitCount: 1, totalDwellMs: 30000 }],
      },
    });

    await computeProgressBatch('user-1', repos);

    expect(batchSpy).toHaveBeenCalledOnce();
    const batchItems = batchSpy.mock.calls[0][0];
    const shortItem = batchItems.find(b => b.repoId === 'repo-short');
    const longItem = batchItems.find(b => b.repoId === 'repo-long');

    // repo-short 绝不能匹配到 /docs/org/app-pro/... 的事件
    expect(shortItem?.events).toHaveLength(0);
    expect(longItem?.events).toHaveLength(1);
  });
});
