import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { reviewTutorialByPlatform, getPlatformReviewGate } from './platform-review';
import {
  createReviewHistoryItem,
  appendReviewHistory,
  extractHistoricalContext,
  type ReviewHistoryItem,
} from './history';
import type { LlmReviewResult } from './llm-review';

export interface PatrolItemResult {
  repositoryId: string;
  owner: string;
  repo: string;
  edition: string;
  previousScore?: number;
  newScore: number;
  reason: string;
  calibrated: boolean;
  error?: string;
}

export interface PlatformReviewPatrolReport {
  timestamp: string;
  scannedCount: number;
  candidateCount: number;
  calibratedCount: number;
  results: PatrolItemResult[];
}

/** 巡检异常分数判定门槛 */
export const PATROL_THRESHOLDS = {
  /** 异常高分偏离阈值：>= 95 分纳入凌晨中立复核，防止作弊刷分 */
  abnormalHighScore: 95,
  /** 异常低分偏离阈值：<= 50 分纳入凌晨中立复核，防止初审偏激压低优质教程 */
  abnormalLowScore: 50,
  /** 单次批处理上限，避免长时间占用资源 */
  maxBatchSize: 20,
};

/**
 * 平台每日凌晨评分巡检引擎 (Nightly Platform Review Patrol)
 * 扫描公开教程中“异常高分”、“异常低分”或“所有者近期重评待复核”的版本，
 * 携带历史审评记忆执行中立校准，并记录全过程与原因留痕。
 */
export async function runPlatformReviewPatrol(options?: {
  dryRun?: boolean;
  limit?: number;
}): Promise<PlatformReviewPatrolReport> {
  const gate = await getPlatformReviewGate();
  if (!gate.ok) {
    console.warn('[ReviewPatrol] 平台初审通道未就绪，跳过本次巡检:', gate.reason);
    return {
      timestamp: new Date().toISOString(),
      scannedCount: 0,
      candidateCount: 0,
      calibratedCount: 0,
      results: [],
    };
  }

  const maxLimit = options?.limit ?? PATROL_THRESHOLDS.maxBatchSize;

  // 1. 查询已公开且已具备评分的候选教程
  const repos = await prisma.repository.findMany({
    where: {
      isPublic: true,
    },
    select: {
      id: true,
      owner: true,
      repo: true,
      edition: true,
      reviewLlm: true,
      repoProfile: true,
    },
    take: 200,
    orderBy: { updatedAt: 'desc' },
  });

  const candidates: Array<{
    repo: (typeof repos)[0];
    score: number;
    reason: string;
  }> = [];

  for (const r of repos) {
    const rev = r.reviewLlm as Partial<LlmReviewResult> | null;
    if (!rev || typeof rev.overallScore !== 'number') continue;

    const score = rev.overallScore;
    const profile = (r.repoProfile ?? {}) as Record<string, unknown>;
    const history = (Array.isArray(profile.reviewHistory) ? profile.reviewHistory : []) as ReviewHistoryItem[];
    const lastItem = history[0];

    // 条件 1: 异常高分（>= 95）
    if (score >= PATROL_THRESHOLDS.abnormalHighScore) {
      // 若最近一条已经是平台凌晨巡检复核过的，不重复巡检
      if (lastItem?.trigger !== 'platform_patrol') {
        candidates.push({
          repo: r,
          score,
          reason: `平台凌晨巡检：检测到当前评分 ${score} 分（达到高分阈值 ${PATROL_THRESHOLDS.abnormalHighScore}），启动平台中立复核与基线校准`,
        });
        continue;
      }
    }

    // 条件 2: 异常低分（<= 50）
    if (score <= PATROL_THRESHOLDS.abnormalLowScore) {
      if (lastItem?.trigger !== 'platform_patrol') {
        candidates.push({
          repo: r,
          score,
          reason: `平台凌晨巡检：检测到当前评分 ${score} 分（低于基线阈值 ${PATROL_THRESHOLDS.abnormalLowScore}），启动平台中立复核`,
        });
        continue;
      }
    }

    // 条件 3: 所有者近期重评，尚未经过平台巡检校准
    if (lastItem && lastItem.trigger === 'owner_manual') {
      const appealedTime = new Date(lastItem.timestamp).getTime();
      const oneHourAgo = Date.now() - 3600_000;
      // 距重评发生超过 1 小时且尚未被 patrol 处理
      if (appealedTime <= oneHourAgo) {
        candidates.push({
          repo: r,
          score,
          reason: `平台凌晨巡检：复核所有者最新重评结果（前次 ${score} 分，诉求: ${lastItem.reason || '无'}）`,
        });
      }
    }
  }

  const selectedCandidates = candidates.slice(0, maxLimit);
  const results: PatrolItemResult[] = [];
  let calibratedCount = 0;

  for (const c of selectedCandidates) {
    const { repo, score, reason } = c;

    if (options?.dryRun) {
      results.push({
        repositoryId: repo.id,
        owner: repo.owner,
        repo: repo.repo,
        edition: repo.edition,
        previousScore: score,
        newScore: score,
        reason,
        calibrated: false,
      });
      continue;
    }

    try {
      // 提取历史上下文，确保平台重评时参考历史背景与本次巡检原因，杜绝突然跑偏
      const historicalContext = extractHistoricalContext(repo.reviewLlm, 'platform_patrol', reason);

      const newReview = await reviewTutorialByPlatform(repo.id, undefined, {
        historicalContext,
      });

      if (newReview.unavailable) {
        results.push({
          repositoryId: repo.id,
          owner: repo.owner,
          repo: repo.repo,
          edition: repo.edition,
          previousScore: score,
          newScore: score,
          reason,
          calibrated: false,
          error: newReview.concerns?.[0] || '平台审评通道暂不可用',
        });
        continue;
      }

      // 构造平台巡检审计留痕记录
      const historyItem = createReviewHistoryItem({
        trigger: 'platform_patrol',
        operatorId: 'system_platform_patrol',
        operatorRole: 'system',
        keyOrigin: 'platform',
        model: `${gate.provider}/${gate.model}`,
        provider: gate.provider,
        previousScore: score,
        newScore: newReview.overallScore,
        reason,
        reviewResult: newReview,
      });

      const updatedProfile = appendReviewHistory(
        repo.repoProfile as Record<string, unknown> | null,
        historyItem
      );

      // 持久化校准结果
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repo.id,
          reviewLlm: newReview,
          repoProfile: updatedProfile,
          touchReviewedAt: true,
        },
        { label: 'patrol-repo-patch' }
      );

      calibratedCount++;
      results.push({
        repositoryId: repo.id,
        owner: repo.owner,
        repo: repo.repo,
        edition: repo.edition,
        previousScore: score,
        newScore: newReview.overallScore,
        reason,
        calibrated: true,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        repositoryId: repo.id,
        owner: repo.owner,
        repo: repo.repo,
        edition: repo.edition,
        previousScore: score,
        newScore: score,
        reason,
        calibrated: false,
        error: errMsg,
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    scannedCount: repos.length,
    candidateCount: candidates.length,
    calibratedCount,
    results,
  };
}
