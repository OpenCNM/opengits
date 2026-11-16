import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 平台中立发布初审（BUG-M05-02 修复）回归：
 * - 安全裁决走平台自有审核模型（PlatformReviewConfig，admin 热配置），不再用发布者 BYOK；
 * - 调用必须携带 keyOrigin='platform'（计入平台日预算熔断——恶意刷发布的费用天花板）；
 * - 关键词黑名单命中不调 LLM 直接扣留（零成本裸防线，假端点无法绕过）；
 * - 任何不可用 fail-closed 转人工，并带结构化 failureReason 供发布反馈分层提示。
 */

const configFindUniqueMock = vi.fn();
const repoFindUniqueMock = vi.fn();
const docFindManyMock = vi.fn();
const generateStructuredMock = vi.fn();
const getDynamicModelMock = vi.fn();
const logSDKResultMock = vi.fn();

class MockBudgetExceededError extends Error {
  constructor(message = 'budget exceeded') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

vi.mock('@/lib/db', () => ({
  prisma: {
    platformReviewConfig: { findUnique: configFindUniqueMock },
    repository: { findUnique: repoFindUniqueMock },
    document: { findMany: docFindManyMock },
  },
}));

vi.mock('@/lib/ai', () => ({
  generateStructured: generateStructuredMock,
  getDynamicModel: getDynamicModelMock,
  trackTokenUsage: vi.fn(),
}));

vi.mock('@/lib/analytics/token-usage', () => ({
  TokenUsageService: { logSDKResult: logSDKResultMock },
}));

vi.mock('@/lib/llm-budget', () => ({
  BudgetExceededError: MockBudgetExceededError,
}));

vi.mock('@/lib/crypto/api-key-cipher', () => ({
  tryDecryptApiKey: vi.fn(() => 'plat-key-123'),
  encryptApiKey: vi.fn(),
  maskApiKey: vi.fn(),
}));

function mockReviewContext() {
  repoFindUniqueMock.mockResolvedValue({
    owner: 'o',
    repo: 'r',
    bestUsedFor: ['backend tutorial'],
    outlines: [{ chapters: [{ title: 'chapter-1' }] }],
  });
  docFindManyMock.mockResolvedValue([{ title: 'doc-1', content: 'normal tutorial content' }]);
}

function enabledConfig() {
  configFindUniqueMock.mockResolvedValue({
    id: 'singleton',
    isEnabled: true,
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    apiKeyEncrypted: 'enc:v1:iv:tag:ct',
  });
}

describe('reviewTutorialByPlatform（平台中立初审）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewContext();
    getDynamicModelMock.mockReturnValue({ tag: 'platform-model' });
  });

  it('未配置/未启用 → fail-closed 转人工（config_missing），绝不调用 LLM', async () => {
    configFindUniqueMock.mockResolvedValue(null);
    const { reviewTutorialByPlatform } = await import('@/lib/review/platform-review');

    const result = await reviewTutorialByPlatform('repo-1', 'user-1');

    expect(result.unavailable).toBe(true);
    expect(result.failureReason).toBe('config_missing');
    expect(result.safetyFlag).toBe(false);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it('已配置 → 用平台配置构造模型，keyOrigin=platform，记账 source=publish_review', async () => {
    enabledConfig();
    generateStructuredMock.mockResolvedValue({
      object: {
        overallScore: 8, // 十分制 → 归一化 80
        archetype: 'PRACTICAL',
        coreHighlight: '实战向',
        targetAudience: '后端工程师',
        dimensions: [{ name: 'depth', score: 7, comment: '尚可' }],
        concerns: [],
        confidence: 0.9,
        safetyFlag: false,
      },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const { reviewTutorialByPlatform } = await import('@/lib/review/platform-review');

    const result = await reviewTutorialByPlatform('repo-1', 'user-1');

    // 法官模型来自平台配置，且必须带平台预算口径
    expect(getDynamicModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'dashscope', modelId: 'qwen-turbo', apiKey: 'plat-key-123' })
    );
    expect(generateStructuredMock).toHaveBeenCalledWith(
      expect.objectContaining({ keyOrigin: 'platform', model: { tag: 'platform-model' } })
    );
    expect(logSDKResultMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ totalTokens: 150 }),
      expect.objectContaining({ source: 'publish_review', keyOrigin: 'platform', model: 'qwen-turbo' })
    );
    // 归一化与流派自适应加权：PRACTICAL 源码流派加权后为 78；安全放行
    expect(result.unavailable).toBeUndefined();
    expect(result.overallScore).toBe(78);
    expect(result.safetyFlag).toBe(false);
  });

  it('平台日预算打满 → budget_exceeded fail-closed，不阻塞为自动公开', async () => {
    enabledConfig();
    generateStructuredMock.mockRejectedValue(new MockBudgetExceededError());
    const { reviewTutorialByPlatform } = await import('@/lib/review/platform-review');

    const result = await reviewTutorialByPlatform('repo-1', 'user-1');

    expect(result.unavailable).toBe(true);
    expect(result.failureReason).toBe('budget_exceeded');
    expect(result.safetyFlag).toBe(false);
  });

  it('内容命中关键词黑名单 → 不调 LLM 直接扣留（keywordHit）', async () => {
    enabledConfig();
    docFindManyMock.mockResolvedValue([{ title: 'doc-1', content: '本文介绍如何搭建博彩网站' }]);
    const { reviewTutorialByPlatform } = await import('@/lib/review/platform-review');

    const result = await reviewTutorialByPlatform('repo-1', 'user-1');

    expect(result.keywordHit).toBe(true);
    expect(result.safetyFlag).toBe(true);
    expect(result.concerns[0]).toContain('赌博');
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });
});

describe('buildReviewFeedback（结构化用户反馈）', () => {
  it('safety_flag 反馈包含其生成模型与整改路径', async () => {
    const { buildReviewFeedback } = await import('@/lib/review/platform-review');
    const feedback = buildReviewFeedback(
      { overallScore: 0, passed: false, confidence: 0.9, safetyFlag: true, dimensions: [], concerns: ['含侵权代码'] },
      'qwen-max'
    );
    expect(feedback.reason).toBe('safety_flag');
    expect(feedback.guidance).toContain('qwen-max');
    expect(feedback.guidance).toContain('重新');
  });

  it('config_missing 反馈无需用户操作', async () => {
    const { buildReviewFeedback } = await import('@/lib/review/platform-review');
    const { unavailableReviewResult } = await import('@/lib/review/llm-review');
    const feedback = buildReviewFeedback(
      { ...unavailableReviewResult('平台初审通道未配置', 'config_missing') }
    );
    expect(feedback.reason).toBe('config_missing');
    expect(feedback.guidance).toContain('无需操作');
  });
});
