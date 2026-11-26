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

export const PATROL_THRESHOLDS = {
  abnormalHighScore: 95,
  abnormalLowScore: 50,
  maxBatchSize: 20,
};

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

    if (score >= PATROL_THRESHOLDS.abnormalHighScore) {
      // Skip items whose latest history entry is already platform_patrol to avoid repeat sweeps.
      if (lastItem?.trigger !== 'platform_patrol') {
        candidates.push({
          repo: r,
          score,
          reason: `平台凌晨巡检：检测到当前评分 ${score} 分（达到高分阈值 ${PATROL_THRESHOLDS.abnormalHighScore}），启动平台中立复核与基线校准`,
        });
        continue;
      }
    }

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

    if (lastItem && lastItem.trigger === 'owner_manual') {
      const appealedTime = new Date(lastItem.timestamp).getTime();
      const oneHourAgo = Date.now() - 3600_000;
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
