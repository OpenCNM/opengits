import { prisma } from '@/lib/db';
import { TELEMETRY_EVENTS } from '@/lib/telemetry/events';
import { ENGINE_CONFIG } from '@/lib/config';
import { ignoreBestEffort } from '@/lib/best-effort';

interface UpdateFunnelOverview {
  totalImpressions: number;
  totalDismissals: number;
  totalViews: number;
  totalApplies: number;
  dismissRate: number;
  viewRate: number;
  applyFromViewRate: number;
  overallConversionRate: number;
}

interface FunnelStepItem {
  step: number;
  key: string;
  name: string;
  count: number;
  percentage: number;
  dropoffRate?: number;
  description: string;
}

interface RepoFunnelBreakdown {
  owner: string;
  repo: string;
  impressions: number;
  dismissals: number;
  views: number;
  applies: number;
  conversionRate: number;
  lastEventAt: string | null;
}

interface RecentFunnelEvent {
  id: string;
  eventType: string;
  owner: string;
  repo: string;
  createdAt: string;
  pageUrl?: string;
  dismissCount?: number;
  runId?: string;
}

export interface UpdateFunnelMetrics {
  overview: UpdateFunnelOverview;
  funnelSteps: FunnelStepItem[];
  repoBreakdown: RepoFunnelBreakdown[];
  recentEvents: RecentFunnelEvent[];
}

export async function computeUpdateFunnelMetrics(): Promise<UpdateFunnelMetrics> {
  const targetEventTypes = [
    TELEMETRY_EVENTS.UPSTREAM_TOAST_IMPRESSION,
    TELEMETRY_EVENTS.UPSTREAM_TOAST_DISMISSED,
    TELEMETRY_EVENTS.UPSTREAM_TOAST_VIEW_PLAN,
    TELEMETRY_EVENTS.UPSTREAM_UPDATE_APPLIED,
  ];

  const events = await prisma.episodicEvent.findMany({
    where: {
      eventType: { in: targetEventTypes },
    },
    select: {
      id: true,
      eventType: true,
      targetId: true,
      pageUrl: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: ENGINE_CONFIG.pagination.adminDefault * 20,
  }).catch((err) => {
    ignoreBestEffort(err);
    return [];
  });

  let impressions = 0;
  let dismissals = 0;
  let views = 0;
  let applies = 0;

  const repoMap = new Map<string, {
    owner: string;
    repo: string;
    impressions: number;
    dismissals: number;
    views: number;
    applies: number;
    lastEventAt: Date | null;
  }>();

  const recentEvents: RecentFunnelEvent[] = [];

  for (const ev of events) {
    const meta = (ev.metadata as Record<string, any>) || {};
    let owner = meta.owner;
    let repo = meta.repo;

    if ((!owner || !repo) && ev.pageUrl && ev.pageUrl.startsWith('/docs/')) {
      const parts = ev.pageUrl.split('/').filter(Boolean);
      if (parts.length >= 3) {
        owner = owner || parts[1];
        repo = repo || parts[2];
      }
    }

    owner = owner || 'unknown';
    repo = repo || 'unknown';
    const repoKey = `${owner}/${repo}`;

    if (!repoMap.has(repoKey) && repoKey !== 'unknown/unknown') {
      repoMap.set(repoKey, {
        owner,
        repo,
        impressions: 0,
        dismissals: 0,
        views: 0,
        applies: 0,
        lastEventAt: ev.createdAt,
      });
    }

    const currentRepo = repoMap.get(repoKey);

    if (ev.eventType === TELEMETRY_EVENTS.UPSTREAM_TOAST_IMPRESSION) {
      impressions++;
      if (currentRepo) currentRepo.impressions++;
    } else if (ev.eventType === TELEMETRY_EVENTS.UPSTREAM_TOAST_DISMISSED) {
      dismissals++;
      if (currentRepo) currentRepo.dismissals++;
    } else if (ev.eventType === TELEMETRY_EVENTS.UPSTREAM_TOAST_VIEW_PLAN) {
      views++;
      if (currentRepo) currentRepo.views++;
    } else if (ev.eventType === TELEMETRY_EVENTS.UPSTREAM_UPDATE_APPLIED) {
      applies++;
      if (currentRepo) currentRepo.applies++;
    }

    if (recentEvents.length < 25) {
      recentEvents.push({
        id: ev.id,
        eventType: ev.eventType,
        owner,
        repo,
        createdAt: ev.createdAt.toISOString(),
        pageUrl: ev.pageUrl || undefined,
        dismissCount: meta.dismissCount,
        runId: meta.runId,
      });
    }
  }

  const dismissRate = impressions > 0 ? Math.round((dismissals / impressions) * 1000) / 10 : 0;
  const viewRate = impressions > 0 ? Math.round((views / impressions) * 1000) / 10 : 0;
  const applyFromViewRate = views > 0 ? Math.round((applies / views) * 1000) / 10 : 0;
  const overallConversionRate = impressions > 0 ? Math.round((applies / impressions) * 1000) / 10 : 0;

  const funnelSteps: FunnelStepItem[] = [
    {
      step: 1,
      key: 'impression',
      name: '浮动 Toast 曝光展示',
      count: impressions,
      percentage: impressions > 0 ? 100 : 0,
      description: '触发上游 Commit 更新提醒向用户呈现的总次数',
    },
    {
      step: 2,
      key: 'dismiss',
      name: '主动关闭提醒 (✕)',
      count: dismissals,
      percentage: dismissRate,
      dropoffRate: dismissRate,
      description: '用户选择暂不更新并主动点击关闭',
    },
    {
      step: 3,
      key: 'view_plan',
      name: '点击「查看」计划',
      count: views,
      percentage: viewRate,
      description: '用户打开更新计划弹窗进行 Diff 审查',
    },
    {
      step: 4,
      key: 'update_applied',
      name: '确认并实际应用同步',
      count: applies,
      percentage: overallConversionRate,
      description: '完成全仓增量重置与后台转录派发',
    },
  ];

  const repoBreakdown: RepoFunnelBreakdown[] = Array.from(repoMap.values())
    .map((r) => ({
      owner: r.owner,
      repo: r.repo,
      impressions: r.impressions,
      dismissals: r.dismissals,
      views: r.views,
      applies: r.applies,
      conversionRate: r.impressions > 0 ? Math.round((r.applies / r.impressions) * 1000) / 10 : 0,
      lastEventAt: r.lastEventAt ? r.lastEventAt.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  return {
    overview: {
      totalImpressions: impressions,
      totalDismissals: dismissals,
      totalViews: views,
      totalApplies: applies,
      dismissRate,
      viewRate,
      applyFromViewRate,
      overallConversionRate,
    },
    funnelSteps,
    repoBreakdown,
    recentEvents,
  };
}
