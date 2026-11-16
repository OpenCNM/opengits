import { describe, it, expect, vi } from 'vitest';
import { computeUserJourneyMetrics } from '@/engine/analytics/user-journey';

vi.mock('@/lib/db', () => ({
  prisma: {
    episodicEvent: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        if (where?.eventType === 'IMPORT_INITIATED') {
          return Promise.resolve([
            { targetId: 'https://github.com/facebook/react', metadata: { owner: 'facebook', repo: 'react' }, createdAt: new Date() },
            { targetId: 'https://github.com/facebook/react', metadata: { owner: 'facebook', repo: 'react' }, createdAt: new Date() },
            { targetId: 'https://github.com/vuejs/core', metadata: { owner: 'vuejs', repo: 'core' }, createdAt: new Date() },
          ]);
        }
        if (where?.eventType === 'IMPORT_INGEST_COMPLETED') {
          return Promise.resolve([
            { duration: 25000, metadata: { totalDurationMs: 25000, activeDwellMs: 24000 }, createdAt: new Date() },
            { duration: 32000, metadata: { totalDurationMs: 32000, activeDwellMs: 30000 }, createdAt: new Date() },
            { duration: 45000, metadata: { totalDurationMs: 45000, activeDwellMs: 42000 }, createdAt: new Date() },
          ]);
        }
        if (where?.eventType === 'IMPORT_ABANDONED') {
          return Promise.resolve([
            { duration: 15000, metadata: { stage: 'scout_loading', waitDurationMs: 15000, activeDwellMs: 15000, reason: 'USER_CANCELLED' }, createdAt: new Date() },
            { duration: 48000, metadata: { stage: 'ingesting', waitDurationMs: 48000, activeDwellMs: 45000, reason: 'TAB_CLOSED' }, createdAt: new Date() },
            { duration: 85000, metadata: { stage: 'ingesting', waitDurationMs: 85000, activeDwellMs: 80000, reason: 'USER_CANCELLED' }, createdAt: new Date() },
          ]);
        }
        if (where?.eventType === 'FIRST_CHAPTER_READ') {
          return Promise.resolve([
            { duration: 15000, metadata: { scrollPercent: 95 } },
          ]);
        }
        if (where?.eventType === 'AI_CHAT_ENGAGED') {
          return Promise.resolve([
            { id: 'chat-1', createdAt: new Date() },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
    repository: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'repo-1', owner: 'facebook', repo: 'react', createdAt: new Date(), views: 10 },
        { id: 'repo-2', owner: 'vuejs', repo: 'core', createdAt: new Date(), views: 5 },
      ]),
    },
    importRecord: {
      findMany: vi.fn().mockResolvedValue([
        { owner: 'facebook', repo: 'react', createdAt: new Date() },
        { owner: 'facebook', repo: 'react', createdAt: new Date() },
        { owner: 'vuejs', repo: 'core', createdAt: new Date() },
      ]),
    },
    user: {
      count: vi.fn().mockResolvedValue(5),
    },
  },
}));

describe('User Journey Analytics Engine', () => {
  it('should accurately compute P50/P90 quantiles, drop-off histogram, and top repos', async () => {
    const metrics = await computeUserJourneyMetrics();

    expect(metrics).toBeDefined();
    expect(metrics.overview.totalImportsInitiated).toBeGreaterThanOrEqual(3);
    expect(metrics.overview.totalImportsCompleted).toBeGreaterThanOrEqual(3);
    expect(metrics.overview.totalAbandonments).toBe(3);

    // Verify P50 / P90 calculation (24s, 30s, 42s -> median 30s)
    expect(metrics.overview.p50WaitSeconds).toBe(30);
    expect(metrics.overview.p90WaitSeconds).toBeGreaterThanOrEqual(30);

    // Verify wait drop-off histogram buckets
    expect(metrics.waitDropoffHistogram).toHaveLength(4);
    const under30sBucket = metrics.waitDropoffHistogram.find((b) => b.bucketLabel === '< 30 秒');
    const inflectionBucket = metrics.waitDropoffHistogram.find((b) => b.bucketLabel === '1m ~ 3 分钟');

    expect(under30sBucket?.count).toBe(1); // 15s
    expect(inflectionBucket?.count).toBe(1); // 80s
    expect(inflectionBucket?.isInflectionPoint).toBe(true);

    // Verify top imported repos ranking
    expect(metrics.topImportedRepos.length).toBeGreaterThanOrEqual(2);
    expect(metrics.topImportedRepos[0].owner).toBe('facebook');
    expect(metrics.topImportedRepos[0].repo).toBe('react');
    expect(metrics.topImportedRepos[0].importCount).toBe(2);
  });
});
