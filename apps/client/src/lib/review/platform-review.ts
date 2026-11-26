import { prisma } from '@/lib/db';
import { generateStructured, getDynamicModel } from '@/lib/ai';
import { ENGINE_CONFIG } from '@/lib/config';
import { TokenUsageService } from '@/lib/analytics/token-usage';
import { BudgetExceededError } from '@/lib/llm-budget';
import { tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import {
  buildReviewPrompt,
  gatherReviewContext,
  reviewSchema,
  toLlmReviewResult,
  unavailableReviewResult,
  type LlmReviewResult,
} from './llm-review';
import { matchBlockedKeywords } from './keyword-blocklist';
import type { HistoricalReviewContext } from './history';

export type PlatformReviewFailureReason = 'config_missing' | 'call_failed' | 'budget_exceeded';

export interface PlatformReviewGate {
  ok: boolean;
  reason?: 'config_missing';
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export async function getPlatformReviewGate(): Promise<PlatformReviewGate> {
  const cfg = await prisma.platformReviewConfig
    .findUnique({ where: { id: 'singleton' } })
    .catch(() => null);

  if (!cfg || !cfg.isEnabled || !cfg.baseUrl || !cfg.model) {
    return { ok: false, reason: 'config_missing' };
  }
  const apiKey = tryDecryptApiKey(cfg.apiKeyEncrypted) ?? '';
  if (!apiKey) {
    return { ok: false, reason: 'config_missing' };
  }
  return { ok: true, provider: cfg.provider || 'openai', baseUrl: cfg.baseUrl, model: cfg.model, apiKey };
}

export async function reviewTutorialByPlatform(
  repositoryId: string,
  userId?: string,
  options?: { timeoutMs?: number; historicalContext?: HistoricalReviewContext }
): Promise<LlmReviewResult> {
  const ctx = await gatherReviewContext(repositoryId, options?.historicalContext);
  if (!ctx) {
    return unavailableReviewResult('仓库不存在', 'call_failed');
  }

  const keywordHits = matchBlockedKeywords([
    ctx.bestUsedFor,
    ctx.chapterTitles.join('\n'),
    ctx.excerpts,
  ]);
  if (keywordHits.length > 0) {
    const categories = [...new Set(keywordHits.map((h) => h.category))].join('、');
    return {
      overallScore: 0,
      passed: false,
      confidence: 1,
      safetyFlag: true,
      dimensions: [],
      concerns: [`内容命中平台关键词黑名单（${categories}），已扣留人工审核`],
      summary: '命中平台内容安全黑名单',
      keywordHit: true,
    };
  }

  const gate = await getPlatformReviewGate();
  if (!gate.ok) {
    return unavailableReviewResult('平台初审通道未配置，已转人工审核队列', gate.reason);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const model = getDynamicModel({
      provider: gate.provider,
      modelId: gate.model,
      apiKey: gate.apiKey,
      baseURL: gate.baseUrl || undefined,
    });

    const timeoutMs = options?.timeoutMs ?? ENGINE_CONFIG.timeouts.platformReviewMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`platform review timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    const result = await Promise.race([
      generateStructured({
        model,
        userId,
        keyOrigin: 'platform',
        source: 'publish_review',
        schema: reviewSchema,
        prompt: await buildReviewPrompt(ctx),
      }),
      timeoutPromise,
    ]);

    await TokenUsageService.logSDKResult(userId ?? '', result.usage, {
      source: 'publish_review',
      keyOrigin: 'platform',
      model: gate.model,
      provider: gate.provider,
      repositoryId,
    });

    return toLlmReviewResult(result.object, ctx.userIntent);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      console.warn('[PlatformReview] 平台审核日预算已满，转人工队列');
      return unavailableReviewResult('平台初审通道今日额度已满，已转人工审核队列', 'budget_exceeded');
    }
    const errMessage = error instanceof Error ? error.message : String(error);
    console.warn('[PlatformReview] 平台初审调用失败，转人工队列:', errMessage);
    return unavailableReviewResult(
      `平台初审通道调用失败: ${errMessage}，已转人工审核队列`,
      'call_failed'
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export interface ReviewFeedback {
  reason: 'safety_flag' | 'keyword_hit' | 'config_missing' | 'call_failed' | 'budget_exceeded';
  concerns: string[];
  guidance: string;
}

export function buildReviewFeedback(
  review: LlmReviewResult,
  generationModel?: string | null
): ReviewFeedback {
  const modelHint = generationModel ? `该内容由你的模型「${generationModel}」生成，` : '';

  if (review.keywordHit) {
    return {
      reason: 'keyword_hit',
      concerns: review.concerns,
      guidance: `内容命中平台内容安全黑名单，无法自动公开。请检查并修正相关章节后重新发布；${modelHint}必要时更换模型重新转录。也可等待管理员人工审核。`,
    };
  }
  if (review.failureReason === 'config_missing') {
    return {
      reason: 'config_missing',
      concerns: review.concerns,
      guidance: '平台初审通道尚未配置，本次发布已转人工审核队列，无需操作；管理员确认通过后将自动公开。',
    };
  }
  if (review.failureReason === 'budget_exceeded') {
    return {
      reason: 'budget_exceeded',
      concerns: review.concerns,
      guidance: '平台初审通道今日额度已满，本次发布已转人工审核队列，请耐心等待管理员审核。',
    };
  }
  if (review.failureReason === 'call_failed') {
    return {
      reason: 'call_failed',
      concerns: review.concerns,
      guidance: '平台初审通道暂时不可用，本次发布已转人工审核队列，请耐心等待管理员审核。',
    };
  }
  return {
    reason: 'safety_flag',
    concerns: review.concerns,
    guidance: `系统检测到内容存在潜在安全风险。${modelHint}请检查并修正相关章节（或更换模型重新生成）后重新发布；本次发布已转人工审核队列，管理员确认通过后将自动公开。`,
  };
}
