// 平台中立发布初审（审计矩阵 BUG-M05-02 修复）。
//
// 背景：发布安全裁决曾使用发布者自己的 BYOK 模型——发布者把 baseUrl 指向假端点
// 即可自判「安全」绕过审核（考生自己改自己的卷子）。本模块把安全裁决迁移到
// 平台自有审核模型（PlatformReviewConfig 单例，admin 热配置）：
//   - 发布时直读配置（无缓存）：admin 改完即生效；
//   - keyOrigin='platform'：计入 PlatformBudgetConfig 日预算熔断，恶意刷发布的
//     费用爆炸半径被预算闸锁死（超限 → BudgetExceededError → 转人工）；
//   - 每次调用记账 TokenUsageLog(source='publish_review', keyOrigin='platform')；
//   - 任何不可用（未配置/调用失败/预算超限）一律 fail-closed 转人工队列。

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
  /** ok=false 时的归因：配置缺失/未启用 */
  reason?: 'config_missing';
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** 直读审核配置（无缓存——admin 保存即对下一次发布生效）；未启用或缺要素视为未配置 */
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

/**
 * 平台中立初审：六维质量画像 + 安全裁决（safetyFlag 为唯一发布拦截条件）。
 * 内容与用户 BYOK 无关的判据见 llm-review（同一 schema/提示词/归一化）。
 */
export async function reviewTutorialByPlatform(
  repositoryId: string,
  userId?: string,
  options?: { timeoutMs?: number; historicalContext?: HistoricalReviewContext }
): Promise<LlmReviewResult> {
  const ctx = await gatherReviewContext(repositoryId, options?.historicalContext);
  if (!ctx) {
    return unavailableReviewResult('仓库不存在', 'call_failed');
  }

  // 零成本裸防线：关键词黑名单命中 → 不调 LLM 直接扣留人工（假端点无法绕过）
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

    // 发布接口/管理复核等待初审：超时 fail-closed 转人工，支持选项覆盖或配置默认
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

    // 预算闸的计数源必须可靠落库：await 记账（fire-and-forget 失败会让熔断迟钝）
    await TokenUsageService.logSDKResult(userId ?? '', result.usage, {
      source: 'publish_review',
      keyOrigin: 'platform',
      model: gate.model,
      provider: gate.provider,
      repositoryId,
    });

    return toLlmReviewResult(result.object);
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
  /** 面向用户的可操作建议（含其生成模型与整改路径） */
  guidance: string;
}

/** 纯函数：由初审结果构造用户侧结构化反馈（告诉用户发生了什么、该怎么改） */
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
