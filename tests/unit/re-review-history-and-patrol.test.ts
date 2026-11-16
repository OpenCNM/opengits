import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createReviewHistoryItem,
  appendReviewHistory,
  extractHistoricalContext,
} from '@/lib/review/history';
import { buildReviewPrompt, type ReviewContext } from '@/lib/review/llm-review';
import { reviewTutorialByUser } from '@/lib/review/user-review';
import { runPlatformReviewPatrol, PATROL_THRESHOLDS } from '@/lib/review/review-patrol';

const mockGenerateStructured = vi.fn();
const mockLogSDKResult = vi.fn();
const mockResolveActiveUserModel = vi.fn();
const mockToInjectableStructuredModel = vi.fn();
const mockGatherReviewContext = vi.fn();
const mockRepositoryFindMany = vi.fn();
const mockCallSidecar = vi.fn().mockResolvedValue({ ok: true });
const mockGetPlatformReviewGate = vi.fn();
const mockReviewTutorialByPlatform = vi.fn();

vi.mock('@/lib/ai', () => ({
  generateStructured: (...args: unknown[]) => mockGenerateStructured(...args),
  defaultEngineProvider: 'openai',
  defaultEngineModel: 'gpt-4o',
}));

vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (...args: unknown[]) => mockResolveActiveUserModel(...args),
  toInjectableStructuredModel: (...args: unknown[]) => mockToInjectableStructuredModel(...args),
}));

vi.mock('@/lib/analytics/token-usage', () => ({
  TokenUsageService: {
    logSDKResult: (...args: unknown[]) => mockLogSDKResult(...args),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: (...args: unknown[]) => mockRepositoryFindMany(...args),
      findUnique: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/prompt-registry', () => ({
  PromptRegistry: {
    getCompiledPrompt: vi.fn().mockResolvedValue({
      compiledPrompt: '【待评测仓库】test/repo\n【章节目录】\n1. intro',
    }),
  },
}));

vi.mock('@/lib/review/platform-review', () => ({
  getPlatformReviewGate: (...args: unknown[]) => mockGetPlatformReviewGate(...args),
  reviewTutorialByPlatform: (...args: unknown[]) => mockReviewTutorialByPlatform(...args),
}));

describe('审评历史留痕与历史感知校准 (Review History & Historical Calibration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createReviewHistoryItem 与 appendReviewHistory 能安全追加历史并维持上限', () => {
    const item1 = createReviewHistoryItem({
      trigger: 'owner_manual',
      operatorId: 'user-1',
      operatorRole: 'owner',
      keyOrigin: 'user',
      model: 'deepseek/deepseek-chat',
      previousScore: 82,
      newScore: 88,
      reason: '补充了宏观架构与控制面解构',
      reviewResult: {
        overallScore: 88,
        passed: true,
        confidence: 0.9,
        safetyFlag: false,
        dimensions: [{ name: 'depth', score: 90, comment: '架构深入' }],
        concerns: [],
      },
    });

    expect(item1.id).toBeDefined();
    expect(item1.trigger).toBe('owner_manual');
    expect(item1.newScore).toBe(88);

    const initialProfile = { siteTitle: 'Demo Repo', reviewHistory: [] };
    const updated = appendReviewHistory(initialProfile, item1);

    expect((updated.reviewHistory as unknown[]).length).toBe(1);
    expect((updated.reviewHistory as typeof item1[])[0].newScore).toBe(88);

    // 连续追加超过 20 条，验证只保留最近 20 条
    let currentProfile = updated;
    for (let i = 0; i < 25; i++) {
      const nextItem = createReviewHistoryItem({
        trigger: 'platform_patrol',
        operatorId: 'system_platform_patrol',
        keyOrigin: 'platform',
        model: 'zhipu/glm-4-flash',
        previousScore: 88,
        newScore: 89,
        reviewResult: {
          overallScore: 89,
          passed: true,
          confidence: 0.95,
          safetyFlag: false,
          dimensions: [],
          concerns: [],
        },
      });
      currentProfile = appendReviewHistory(currentProfile, nextItem);
    }
    expect((currentProfile.reviewHistory as unknown[]).length).toBe(20);
  });

  it('extractHistoricalContext 能准确提取评分基线供下次校准', () => {
    const currentReview = {
      overallScore: 85,
      archetype: 'SYSTEM_ARCHITECT',
      coreHighlight: '宏观四层架构深刻',
      dimensions: [
        { name: 'depth', score: 90, comment: '深度高' },
        { name: 'pedagogy', score: 85, comment: '讲解生动' },
      ],
    };

    const ctx = extractHistoricalContext(currentReview, 'owner_manual', '希望重点看源码切片');
    expect(ctx).toBeDefined();
    expect(ctx?.previousScore).toBe(85);
    expect(ctx?.previousArchetype).toBe('SYSTEM_ARCHITECT');
    expect(ctx?.previousHighlight).toBe('宏观四层架构深刻');
    expect(ctx?.trigger).toBe('owner_manual');
    expect(ctx?.reason).toBe('希望重点看源码切片');
  });

  it('buildReviewPrompt 会将历史审评上下文注入提示词，引导模型连贯校准，防止突兀跑偏', async () => {
    const reviewCtx: ReviewContext = {
      owner: 'test-owner',
      repo: 'test-repo',
      bestUsedFor: 'Go Developers',
      chapterTitles: ['1. 架构总览', '2. 控制面设计'],
      excerpts: '=== 事实看板 ===',
      historicalContext: {
        previousScore: 86,
        previousArchetype: 'SYSTEM_ARCHITECT',
        previousHighlight: '三层分工清晰',
        previousDimensions: [{ name: 'depth', score: 88, comment: '设计合理' }],
        trigger: 'owner_manual',
        reason: '完善了生命周期状态图，申请复核深入浅出维度',
      },
    };

    const prompt = await buildReviewPrompt(reviewCtx);
    expect(prompt).toContain('历史审评基线与本次校准上下文');
    expect(prompt).toContain('上次评定综合得分: 86 分');
    expect(prompt).toContain('上次判定流派风格: SYSTEM_ARCHITECT');
    expect(prompt).toContain('本次审评核心关注与原因: 完善了生命周期状态图');
    expect(prompt).toContain('避免在缺少物理证据的情况下发生无序、突兀的跳跃跑偏');
  });
});

describe('所有者重评走自有 Token 流量 (Owner Re-Review with User BYOK)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('若用户尚未配置或激活模型，友好阻断并提示配置个人 AI 密钥', async () => {
    mockResolveActiveUserModel.mockResolvedValueOnce(null);

    await expect(
      reviewTutorialByUser('repo-1', 'user-no-key')
    ).rejects.toThrow(/重评需使用您的个人 AI 算力.*请前往「设置 - 模型配置」/);
  });

  it('用户配置了模型时，严格使用 keyOrigin: user 与用户模型执行重评并记账', async () => {
    mockResolveActiveUserModel.mockResolvedValueOnce({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      apiKey: 'sk-user-test',
      baseURL: 'https://api.deepseek.com',
      apiFormat: 'openai',
    });
    const fakeModelObj = { modelName: 'deepseek-chat' };
    mockToInjectableStructuredModel.mockReturnValueOnce(fakeModelObj);

    // mock gatherReviewContext inside user-review: since gatherReviewContext comes from llm-review,
    // let's spy on or let it use prisma findUnique
    const { prisma } = await import('@/lib/db');
    (prisma.repository.findUnique as any).mockResolvedValueOnce({
      owner: 'test-owner',
      repo: 'test-repo',
      bestUsedFor: ['后端系统'],
      outlines: [{ chapters: [{ title: '架构概览' }] }],
    });
    (prisma.document.findMany as any) = vi.fn().mockResolvedValueOnce([
      { title: '架构概览', path: 'docs/01.md', content: '```go\nfunc main() {}\n```' },
    ]);

    mockGenerateStructured.mockResolvedValueOnce({
      object: {
        overallScore: 91,
        archetype: 'CODE_DIVER',
        coreHighlight: '深入源码底层',
        targetAudience: '高阶架构师',
        dimensions: [
          { name: 'depth', score: 92, comment: '机制透彻' },
          { name: 'pedagogy', score: 88, comment: '深入浅出' },
          { name: 'codeFidelity', score: 94, comment: '切片精炼' },
          { name: 'coverage', score: 89, comment: '体系完整' },
        ],
        concerns: [],
        confidence: 0.95,
        safetyFlag: false,
      },
      usage: { promptTokens: 500, completionTokens: 120, totalTokens: 620 },
    });

    const res = await reviewTutorialByUser('repo-1', 'user-owner', {
      appealFocus: '强化了源码切片讲解',
    });

    expect(res.review.overallScore).toBe(92); // adaptive weighted
    expect(res.model).toBe('deepseek/deepseek-chat');

    // 验证 generateStructured 调用参数严格标记为 user 流量
    expect(mockGenerateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-owner',
        keyOrigin: 'user',
        source: 're_review',
        model: fakeModelObj,
      })
    );

    // 验证 Token 记账流落入用户个人账本
    expect(mockLogSDKResult).toHaveBeenCalledWith(
      'user-owner',
      expect.objectContaining({ totalTokens: 620 }),
      expect.objectContaining({
        keyOrigin: 'user',
        source: 're_review',
        model: 'deepseek-chat',
        provider: 'deepseek',
        repositoryId: 'repo-1',
      })
    );
  });
});

describe('平台每日凌晨评分巡检引擎 (Nightly Platform Review Patrol)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('精准识别异常高分 (>=95)、异常低分 (<=50) 以及所有者待复核版本', async () => {
    mockGetPlatformReviewGate.mockResolvedValue({
      ok: true,
      provider: 'zhipu',
      model: 'glm-4-flash',
      apiKey: 'sk-platform',
    });

    const repos = [
      {
        id: 'repo-high',
        owner: 'userA',
        repo: 'high-score-repo',
        edition: '',
        reviewLlm: { overallScore: 97, dimensions: [] },
        repoProfile: { reviewHistory: [] },
      },
      {
        id: 'repo-low',
        owner: 'userB',
        repo: 'low-score-repo',
        edition: '',
        reviewLlm: { overallScore: 45, dimensions: [] },
        repoProfile: { reviewHistory: [] },
      },
      {
        id: 'repo-normal',
        owner: 'userC',
        repo: 'normal-repo',
        edition: '',
        reviewLlm: { overallScore: 86, dimensions: [] },
        repoProfile: {
          reviewHistory: [
            {
              id: 'hist-1',
              trigger: 'platform_patrol',
              timestamp: new Date().toISOString(),
              newScore: 86,
            },
          ],
        },
      },
    ];

    mockRepositoryFindMany.mockResolvedValueOnce(repos);

    mockReviewTutorialByPlatform.mockImplementation(async (repoId: string) => {
      if (repoId === 'repo-high') {
        return {
          overallScore: 91,
          passed: true,
          confidence: 0.95,
          safetyFlag: false,
          dimensions: [],
          concerns: [],
          coreHighlight: '平台复核校准，挤出虚高水分',
        };
      }
      if (repoId === 'repo-low') {
        return {
          overallScore: 78,
          passed: true,
          confidence: 0.9,
          safetyFlag: false,
          dimensions: [],
          concerns: [],
          coreHighlight: '平台复核：架构清晰，纠正初审偏激低估',
        };
      }
      return { overallScore: 85, passed: true, confidence: 0.9, safetyFlag: false };
    });

    const report = await runPlatformReviewPatrol();

    expect(report.candidateCount).toBe(2); // 97高分 和 45低分 被命中
    expect(report.calibratedCount).toBe(2);

    // 验证 sidecar 补丁落库包含平台巡检历史
    expect(mockCallSidecar).toHaveBeenCalledTimes(2);
    const firstCallPatch = mockCallSidecar.mock.calls[0][1];
    expect(firstCallPatch.id).toBe('repo-high');
    expect(firstCallPatch.reviewLlm.overallScore).toBe(91);
    expect(firstCallPatch.repoProfile.reviewHistory[0].trigger).toBe('platform_patrol');
    expect(firstCallPatch.repoProfile.reviewHistory[0].operatorRole).toBe('system');
    expect(firstCallPatch.repoProfile.reviewHistory[0].keyOrigin).toBe('platform');
    expect(firstCallPatch.repoProfile.reviewHistory[0].reason).toContain('高分阈值');
  });
});
