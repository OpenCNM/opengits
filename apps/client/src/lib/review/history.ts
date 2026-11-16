import { randomUUID } from 'crypto';
import type { LlmReviewResult } from './llm-review';

/**
 * 审评历史审计条目：
 * 记录每一次所有者重评与平台凌晨巡检的全过程事实、原因与分值演变，
 * 保证评分具备历史可追溯性，杜绝无据突兀跳跃或跑偏。
 */
export interface ReviewHistoryItem {
  id: string;
  timestamp: string;
  trigger: 'owner_manual' | 'platform_patrol' | 'initial_publish';
  operatorId: string;
  operatorRole?: 'owner' | 'maintainer' | 'system' | 'admin';
  keyOrigin: 'user' | 'platform';
  model: string;
  provider?: string;
  previousScore?: number;
  newScore: number;
  reason?: string;
  reviewResult: LlmReviewResult;
}

/**
 * 历史评定上下文（用于注入 LLM 审评 Prompt 做连贯性校准）
 */
export interface HistoricalReviewContext {
  previousScore?: number;
  previousArchetype?: string;
  previousHighlight?: string;
  previousDimensions?: Array<{ name: string; score: number; comment?: string }>;
  trigger: 'owner_manual' | 'platform_patrol' | 'initial_publish';
  reason?: string;
}

const MAX_REVIEW_HISTORY_ENTRIES = 20;

/**
 * 安全追加一条审评历史记录到 repoProfile 中
 */
export function appendReviewHistory(
  existingProfile: Record<string, unknown> | null | undefined,
  entry: ReviewHistoryItem
): Record<string, unknown> {
  const profile = existingProfile ? { ...existingProfile } : {};
  const currentHistory: ReviewHistoryItem[] = Array.isArray(profile.reviewHistory)
    ? (profile.reviewHistory as ReviewHistoryItem[])
    : [];

  const nextHistory = [entry, ...currentHistory].slice(0, MAX_REVIEW_HISTORY_ENTRIES);

  return {
    ...profile,
    reviewHistory: nextHistory,
    lastReviewItem: entry,
  };
}

/**
 * 从仓库实体中提取用于下次审评校准的历史上下文
 */
export function extractHistoricalContext(
  currentReviewLlm: unknown,
  trigger: 'owner_manual' | 'platform_patrol',
  reason?: string
): HistoricalReviewContext | undefined {
  if (!currentReviewLlm || typeof currentReviewLlm !== 'object') {
    return undefined;
  }
  const rev = currentReviewLlm as Partial<LlmReviewResult>;
  if (typeof rev.overallScore !== 'number') {
    return undefined;
  }

  return {
    previousScore: rev.overallScore,
    previousArchetype: rev.archetype,
    previousHighlight: rev.coreHighlight || rev.summary,
    previousDimensions: Array.isArray(rev.dimensions) ? rev.dimensions : undefined,
    trigger,
    reason: reason?.trim() || undefined,
  };
}

/**
 * 创建审评历史条目工厂函数
 */
export function createReviewHistoryItem(params: {
  trigger: 'owner_manual' | 'platform_patrol' | 'initial_publish';
  operatorId: string;
  operatorRole?: 'owner' | 'maintainer' | 'system' | 'admin';
  keyOrigin: 'user' | 'platform';
  model: string;
  provider?: string;
  previousScore?: number;
  newScore: number;
  reason?: string;
  reviewResult: LlmReviewResult;
}): ReviewHistoryItem {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    trigger: params.trigger,
    operatorId: params.operatorId,
    operatorRole: params.operatorRole,
    keyOrigin: params.keyOrigin,
    model: params.model,
    provider: params.provider,
    previousScore: params.previousScore,
    newScore: params.newScore,
    reason: params.reason,
    reviewResult: params.reviewResult,
  };
}
