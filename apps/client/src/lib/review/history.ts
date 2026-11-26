import { randomUUID } from 'crypto';
import type { LlmReviewResult } from './llm-review';

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

export interface HistoricalReviewContext {
  previousScore?: number;
  previousArchetype?: string;
  previousHighlight?: string;
  previousDimensions?: Array<{ name: string; score: number; comment?: string }>;
  trigger: 'owner_manual' | 'platform_patrol' | 'initial_publish';
  reason?: string;
}

const MAX_REVIEW_HISTORY_ENTRIES = 20;

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
