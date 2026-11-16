import { ENGINE_CONFIG } from '@/lib/config';
import { generateStructured } from '@/lib/ai';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { TokenUsageService } from '@/lib/analytics/token-usage';
import { ApiError } from '@/lib/api/server/api-error';
import {
  reviewSchema,
  toLlmReviewResult,
  gatherReviewContext,
  buildReviewPrompt,
  unavailableReviewResult,
  type LlmReviewResult,
} from './llm-review';
import { matchBlockedKeywords } from './keyword-blocklist';
import type { HistoricalReviewContext } from './history';

export interface UserReviewResult {
  review: LlmReviewResult;
  model: string;
  provider: string;
}

/**
 * 所有者发起的教程重评：
 * 1. 严格使用所有者自己的个人 AI 模型 / BYOK Token 流量 (keyOrigin: 'user')；
 * 2. 注入历史审评基线与本次诉求，确保评分具备历史延续性，杜绝无据跑偏；
 * 3. 严格记录用户 Token 消耗流水与过程原因。
 */
export async function reviewTutorialByUser(
  repositoryId: string,
  userId: string,
  options?: {
    timeoutMs?: number;
    appealFocus?: string;
    historicalContext?: HistoricalReviewContext;
  }
): Promise<UserReviewResult> {
  if (!userId) {
    throw ApiError.unauthorized();
  }

  // 1. 解析用户个人激活的模型配置 (BYOK)
  const userModel = await resolveActiveUserModel(userId);
  if (!userModel || !userModel.apiKey) {
    throw ApiError.badRequest(
      '重评需使用您的个人 AI 算力。您尚未配置或激活个人 AI 模型，请前往「设置 - 模型配置」添加并激活您的 AI 服务商凭据后再发起重评。'
    );
  }

  const model = toInjectableStructuredModel(userModel);
  if (!model) {
    throw ApiError.badRequest(
      '您配置的 AI 模型暂不支持结构化评测，请在设置中检查服务商与模型格式是否兼容。'
    );
  }

  // 2. 提取教程全景切片事实看板，附带历史审评校准上下文
  const ctx = await gatherReviewContext(repositoryId, options?.historicalContext);
  if (!ctx) {
    throw ApiError.notFound('未找到对应的教程版本');
  }

  // 3. 安全前置检查：关键词黑名单防线
  const keywordHits = matchBlockedKeywords([
    ctx.bestUsedFor,
    ctx.chapterTitles.join('\n'),
    ctx.excerpts,
  ]);
  if (keywordHits.length > 0) {
    const categories = [...new Set(keywordHits.map((h) => h.category))].join('、');
    return {
      review: {
        overallScore: 0,
        passed: false,
        confidence: 1,
        safetyFlag: true,
        dimensions: [],
        concerns: [`内容命中平台关键词黑名单（${categories}），已扣留人工审核`],
        summary: '命中平台内容安全黑名单',
        keywordHit: true,
      },
      model: `${userModel.provider}/${userModel.modelId}`,
      provider: userModel.provider,
    };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutMs = options?.timeoutMs ?? ENGINE_CONFIG.timeouts.platformReviewMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`user review timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    // 4. 执行结构化评测：keyOrigin: 'user'，严格消耗用户自有配额
    const result = await Promise.race([
      generateStructured({
        model,
        userId,
        keyOrigin: 'user',
        source: 're_review',
        schema: reviewSchema,
        prompt: await buildReviewPrompt(ctx),
      }),
      timeoutPromise,
    ]);

    // 5. 记账到用户个人 Token 账本
    await TokenUsageService.logSDKResult(userId, result.usage, {
      source: 're_review',
      keyOrigin: 'user',
      model: userModel.modelId,
      provider: userModel.provider,
      repositoryId,
    });

    return {
      review: toLlmReviewResult(result.object),
      model: `${userModel.provider}/${userModel.modelId}`,
      provider: userModel.provider,
    };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error(`[reviewTutorialByUser] 用户重评调用异常 (repo=${repositoryId}):`, errMessage);
    return {
      review: unavailableReviewResult(`重评执行异常: ${errMessage}`, 'call_failed'),
      model: `${userModel.provider}/${userModel.modelId}`,
      provider: userModel.provider,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
