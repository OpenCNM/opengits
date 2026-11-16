import { describe, it, expect, vi } from 'vitest';
import { computeUpdateFunnelMetrics } from '@/engine/analytics/update-funnel';

vi.mock('@/lib/db', () => ({
  prisma: {
    episodicEvent: {
      findMany: vi.fn().mockImplementation(() => {
        return Promise.resolve([
          // 4 Impressions
          { id: '1', eventType: 'UPSTREAM_TOAST_IMPRESSION', metadata: { owner: 'bojieli', repo: 'ai-agent-book' }, createdAt: new Date() },
          { id: '2', eventType: 'UPSTREAM_TOAST_IMPRESSION', metadata: { owner: 'bojieli', repo: 'ai-agent-book' }, createdAt: new Date() },
          { id: '3', eventType: 'UPSTREAM_TOAST_IMPRESSION', metadata: { owner: 'meta-llama', repo: 'llama-stack' }, createdAt: new Date() },
          { id: '4', eventType: 'UPSTREAM_TOAST_IMPRESSION', metadata: { owner: 'meta-llama', repo: 'llama-stack' }, createdAt: new Date() },
          // 1 Dismiss
          { id: '5', eventType: 'UPSTREAM_TOAST_DISMISSED', metadata: { owner: 'bojieli', repo: 'ai-agent-book', dismissCount: 1 }, createdAt: new Date() },
          // 2 View Plan
          { id: '6', eventType: 'UPSTREAM_TOAST_VIEW_PLAN', metadata: { owner: 'bojieli', repo: 'ai-agent-book' }, createdAt: new Date() },
          { id: '7', eventType: 'UPSTREAM_TOAST_VIEW_PLAN', metadata: { owner: 'meta-llama', repo: 'llama-stack' }, createdAt: new Date() },
          // 1 Apply
          { id: '8', eventType: 'UPSTREAM_UPDATE_APPLIED', metadata: { owner: 'bojieli', repo: 'ai-agent-book', runId: 'run-123' }, createdAt: new Date() },
        ]);
      }),
    },
  },
}));

describe('Update Funnel Analytics Engine', () => {
  it('should accurately compute impressions, dismissals, views, applies, and rates', async () => {
    const metrics = await computeUpdateFunnelMetrics();

    expect(metrics).toBeDefined();
    expect(metrics.overview.totalImpressions).toBe(4);
    expect(metrics.overview.totalDismissals).toBe(1);
    expect(metrics.overview.totalViews).toBe(2);
    expect(metrics.overview.totalApplies).toBe(1);

    // Rates:
    // dismissRate = (1/4) * 100 = 25%
    expect(metrics.overview.dismissRate).toBe(25);
    // viewRate = (2/4) * 100 = 50%
    expect(metrics.overview.viewRate).toBe(50);
    // applyFromViewRate = (1/2) * 100 = 50%
    expect(metrics.overview.applyFromViewRate).toBe(50);
    // overallConversionRate = (1/4) * 100 = 25%
    expect(metrics.overview.overallConversionRate).toBe(25);

    // Funnel Steps:
    expect(metrics.funnelSteps).toHaveLength(4);
    expect(metrics.funnelSteps[0].count).toBe(4);
    expect(metrics.funnelSteps[1].count).toBe(1);
    expect(metrics.funnelSteps[2].count).toBe(2);
    expect(metrics.funnelSteps[3].count).toBe(1);

    // Repo Breakdown:
    expect(metrics.repoBreakdown.length).toBeGreaterThanOrEqual(2);
    const bojieliRepo = metrics.repoBreakdown.find((r) => r.owner === 'bojieli' && r.repo === 'ai-agent-book');
    expect(bojieliRepo).toBeDefined();
    expect(bojieliRepo?.impressions).toBe(2);
    expect(bojieliRepo?.dismissals).toBe(1);
    expect(bojieliRepo?.views).toBe(1);
    expect(bojieliRepo?.applies).toBe(1);
    expect(bojieliRepo?.conversionRate).toBe(50); // 1 apply / 2 impressions = 50%

    // Recent events:
    expect(metrics.recentEvents.length).toBe(8);
  });

  it('should handle zero events cleanly with 0% across all rates and percentages', async () => {
    const { prisma } = await import('@/lib/db');
    vi.mocked(prisma.episodicEvent.findMany).mockResolvedValueOnce([]);

    const metrics = await computeUpdateFunnelMetrics();
    expect(metrics.overview.totalImpressions).toBe(0);
    expect(metrics.overview.totalDismissals).toBe(0);
    expect(metrics.overview.totalViews).toBe(0);
    expect(metrics.overview.totalApplies).toBe(0);
    expect(metrics.overview.dismissRate).toBe(0);
    expect(metrics.overview.viewRate).toBe(0);
    expect(metrics.overview.overallConversionRate).toBe(0);
    expect(metrics.funnelSteps[0].percentage).toBe(0);
    expect(metrics.funnelSteps[0].count).toBe(0);
    expect(metrics.repoBreakdown).toEqual([]);
    expect(metrics.recentEvents).toEqual([]);
  });
});
