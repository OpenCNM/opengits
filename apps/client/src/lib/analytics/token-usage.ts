import { prisma } from '@/lib/db';
import { z } from 'zod';

export const LogTokenUsageSchema = z.object({
  userId: z.string(),
  repositoryId: z.string().optional().nullable(),
  conversationId: z.string().optional().nullable(),
  messageId: z.string().optional().nullable(),
  model: z.string(),
  provider: z.string().default('unknown'),
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().optional().default(0),
  reasoningTokens: z.number().int().nonnegative().optional().default(0),
  source: z.string().default('chat'),
  // 花销归属（Phase 2 预算熔断）：platform=平台 key 计入日预算；user=BYOK 豁免
  keyOrigin: z.enum(['platform', 'user']).default('platform'),
  // Prompt eval 捕获侧：网关 purpose 与编译时 prompt 版本（"版本 ↔ 质量"回溯）
  purpose: z.string().optional().nullable(),
  promptVersion: z.number().int().optional().nullable(),
});

// z.input：带默认值的键（source/keyOrigin 等）对调用方可选，zod 解析后补全
export type LogTokenUsageParams = z.input<typeof LogTokenUsageSchema>;

export interface TimeRangeParams {
  timeRange?: '7d' | '30d' | string;
  startDate?: string;
  endDate?: string;
}

export type PhaseKey = 'import' | 'transcription' | 'chat' | 'indexing';

export interface PhaseInfo {
  key: PhaseKey;
  label: string;
  description: string;
}

export const PHASE_DEFINITIONS: Record<PhaseKey, PhaseInfo> = {
  import: {
    key: 'import',
    label: '仓库导入与架构探测阶段',
    description: 'GitHub API 解析、Git Tree 扫描与选单/大纲 AI 匹配',
  },
  transcription: {
    key: 'transcription',
    label: '教程转录与 AI 课件生成阶段',
    description: '费曼大纲构建、代码深度剖析与 AI 课件精炼',
  },
  chat: {
    key: 'chat',
    label: '教程对话问答与疑难诊断阶段',
    description: '教程交互问答、智能架构诊断与随堂测验生成',
  },
  indexing: {
    key: 'indexing',
    label: '知识库向量与 MCP 分析阶段',
    description: '全仓向量索引构建、MCP 图谱边提取与经验提炼',
  },
};

export const SOURCE_TO_PHASE: Record<string, PhaseKey> = {
  // Import phase
  scout: 'import',
  recon: 'import',
  translate_outline: 'import',
  outline_generation: 'import',

  // Transcription phase
  ingest: 'transcription',
  transcription: 'transcription',
  tutor_explanation: 'transcription',
  dissect: 'transcription',
  code_pedagogy: 'transcription',
  ai_condensation: 'transcription',

  // Chat phase
  chat: 'chat',
  diagnostic: 'chat',
  quiz: 'chat',

  // Indexing phase
  indexer: 'indexing',
  vector: 'indexing',
  subagent: 'indexing',
  'llm-edges': 'indexing',
  experience: 'indexing',

  // Review phase（教程公开审核 LLM 初审）
  review: 'indexing',
  publish_review: 'indexing',
};

export const SCENARIO_LABELS: Record<string, string> = {
  scout: '仓库架构探测与选单匹配',
  translate_outline: '多语言大纲翻译',
  ingest: '教程自动化转录入库',
  tutor_explanation: 'LLM 教程解说与分析',
  dissect: '代码剖析与结构化',
  code_pedagogy: '费曼教学法课件生成',
  chat: '教程对话与问答',
  diagnostic: '疑难诊断与评估',
  quiz: '随堂测验生成',
  indexer: '知识库解析与向量处理',
  vector: '向量 Embedding 生成',
  subagent: '子智能体推演与图谱提取',
  'llm-edges': 'LLM 知识概念边构建',
  experience: 'MCP 经验提炼与校验',
};

export interface UsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  tutorialCount: number;
  importTokens: number;
  importPercentage: number;
  transcriptionTokens: number;
  transcriptionPercentage: number;
  chatTokens: number;
  chatPercentage: number;
  indexingTokens: number;
  indexingPercentage: number;
}

export interface TutorialPhaseStat {
  phaseKey: PhaseKey;
  label: string;
  totalTokens: number;
  percentage: number;
  callCount: number;
}

export interface TutorialBreakdownItem {
  repositoryId: string;
  repoName: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  percentage: number;
  callCount: number;
  phases: TutorialPhaseStat[];
}

export interface PhaseBreakdownItem {
  phaseKey: PhaseKey;
  label: string;
  description: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  percentage: number;
  callCount: number;
}

export interface ScenarioBreakdownItem {
  source: string;
  label: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  percentage: number;
  callCount: number;
}

export interface UsageStatisticsResult {
  summary: UsageSummary;
  tutorialBreakdown: TutorialBreakdownItem[];
  phaseBreakdown: PhaseBreakdownItem[];
  scenarioBreakdown: ScenarioBreakdownItem[];
}

export class TokenUsageService {
  /**
   * Log an accurate token usage event directly from LLM API responses.
   */
  static async logUsage(rawParams: LogTokenUsageParams) {
    const validated = LogTokenUsageSchema.parse(rawParams);

    // 防御守卫:userId 是 TokenUsageLog 的非空外键,空串/伪造值都会 P2003 失败。
    // token 统计是用户维度分析,无真实用户(如 session 缺失的系统/后台 LLM 调用)
    // 跳过落库——历史上这些写入从未成功(占位 'system' 用户不存在),跳过零损失。
    if (!validated.userId.trim()) return;

    const calcTotal = validated.totalTokens > 0 
      ? validated.totalTokens 
      : validated.promptTokens + validated.completionTokens;

    return await prisma.tokenUsageLog.create({
      data: {
        userId: validated.userId,
        repositoryId: validated.repositoryId || undefined,
        conversationId: validated.conversationId || undefined,
        messageId: validated.messageId || undefined,
        model: validated.model,
        provider: validated.provider,
        promptTokens: validated.promptTokens,
        completionTokens: validated.completionTokens,
        totalTokens: calcTotal,
        cachedTokens: validated.cachedTokens,
        reasoningTokens: validated.reasoningTokens,
        source: validated.source,
        keyOrigin: validated.keyOrigin,
        purpose: validated.purpose ?? null,
        promptVersion: validated.promptVersion ?? null,
      },
    });
  }

  /**
   * Zero-intrusion helper to log tokens directly from any Vercel AI SDK result
   * (e.g. generateText, generateObject, or streamText onFinish usage).
   * 返回 Promise：预算熔断依赖本台账计数，关键路径（如 publish_review）应 await。
   */
  static logSDKResult(
    userId: string,
    resultUsage: any,
    options: {
      source?: string;
      model?: string;
      provider?: string;
      repositoryId?: string;
      conversationId?: string;
      messageId?: string;
      keyOrigin?: 'platform' | 'user';
      /** Prompt eval 捕获侧：网关 purpose 与编译时 prompt 版本（回溯"版本 ↔ 质量"） */
      purpose?: string;
      promptVersion?: number;
    } = {}
  ): Promise<void> {
    if (!resultUsage) return Promise.resolve();
    const promptTokens = resultUsage.promptTokens || resultUsage.inputTokens || 0;
    const completionTokens = resultUsage.completionTokens || resultUsage.outputTokens || 0;
    const totalTokens = resultUsage.totalTokens || (promptTokens + completionTokens);
    if (totalTokens <= 0) return Promise.resolve();

    return TokenUsageService.logUsage({
      userId,
      repositoryId: options.repositoryId,
      conversationId: options.conversationId,
      messageId: options.messageId,
      model: options.model || 'qwen-max',
      provider: options.provider || 'dashscope',
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
      source: options.source || 'tutor_explanation',
      keyOrigin: options.keyOrigin || 'platform',
      purpose: options.purpose ?? null,
      promptVersion: options.promptVersion ?? null,
    }).then(
      () => undefined,
      (err: unknown) => {
        console.error('[TokenUsageService] Asynchronous logSDKResult failed silently:', err);
      }
    );
  }

  /**
   * Calculate aggregated token usage statistics for a user within a time range,
   * with detailed phase-based (import, transcription, chat, indexing) and tutorial-level breakdowns.
   */
  static async getUsageStatistics(
    userId: string,
    params: TimeRangeParams = {}
  ): Promise<UsageStatisticsResult> {
    const days = params.timeRange === '7d' ? 7 : 30;
    
    const now = new Date();
    const startDate = new Date();
    startDate.setDate(now.getDate() - (days - 1));
    startDate.setHours(0, 0, 0, 0);

    // 显式 select（性能修复 2026-10-13）：include 会拉回 TokenUsageLog 全部标量
    // 列（含 metadata/usage Json 大列），聚合只消费下列字段；聚合不依赖行序，
    // 去掉 orderBy 省一次排序。多维聚合（repo×phase×scenario + conversation
    // repositoryId 回退）保持 JS 侧单遍实现——groupBy 改写需拆 3+ 查询且
    // coalesce 分组键易错，收益不抵语义风险。
    const logs = await prisma.tokenUsageLog.findMany({
      where: {
        userId,
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        totalTokens: true,
        promptTokens: true,
        completionTokens: true,
        source: true,
        repositoryId: true,
        repository: {
          select: {
            id: true,
            owner: true,
            repo: true,
          },
        },
        conversation: {
          select: {
            repositoryId: true,
            repository: {
              select: {
                id: true,
                owner: true,
                repo: true,
              },
            },
          },
        },
      },
    });

    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    const tutorialStatsMap: Record<
      string,
      {
        repoName: string;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        callCount: number;
        phaseTokens: Record<PhaseKey, { totalTokens: number; callCount: number }>;
      }
    > = {};

    const phaseStatsMap: Record<
      PhaseKey,
      { totalTokens: number; promptTokens: number; completionTokens: number; callCount: number }
    > = {
      import: { totalTokens: 0, promptTokens: 0, completionTokens: 0, callCount: 0 },
      transcription: { totalTokens: 0, promptTokens: 0, completionTokens: 0, callCount: 0 },
      chat: { totalTokens: 0, promptTokens: 0, completionTokens: 0, callCount: 0 },
      indexing: { totalTokens: 0, promptTokens: 0, completionTokens: 0, callCount: 0 },
    };

    const scenarioStatsMap: Record<
      string,
      { label: string; totalTokens: number; promptTokens: number; completionTokens: number; callCount: number }
    > = {};

    for (const log of logs) {
      totalTokens += log.totalTokens;
      promptTokens += log.promptTokens;
      completionTokens += log.completionTokens;

      const repoId = log.repositoryId || log.conversation?.repositoryId || 'global';
      const repoOwnerRepo = log.repository 
        ? `${log.repository.owner}/${log.repository.repo}`
        : log.conversation?.repository
        ? `${log.conversation.repository.owner}/${log.conversation.repository.repo}`
        : '全局基础对话';

      const source = log.source || 'chat';
      const phaseKey = SOURCE_TO_PHASE[source] || (source === 'chat' ? 'chat' : 'transcription');

      // Tutorial Map
      if (!tutorialStatsMap[repoId]) {
        tutorialStatsMap[repoId] = {
          repoName: repoOwnerRepo,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          callCount: 0,
          phaseTokens: {
            import: { totalTokens: 0, callCount: 0 },
            transcription: { totalTokens: 0, callCount: 0 },
            chat: { totalTokens: 0, callCount: 0 },
            indexing: { totalTokens: 0, callCount: 0 },
          },
        };
      }
      tutorialStatsMap[repoId].totalTokens += log.totalTokens;
      tutorialStatsMap[repoId].promptTokens += log.promptTokens;
      tutorialStatsMap[repoId].completionTokens += log.completionTokens;
      tutorialStatsMap[repoId].callCount += 1;
      tutorialStatsMap[repoId].phaseTokens[phaseKey].totalTokens += log.totalTokens;
      tutorialStatsMap[repoId].phaseTokens[phaseKey].callCount += 1;

      // Phase Map
      phaseStatsMap[phaseKey].totalTokens += log.totalTokens;
      phaseStatsMap[phaseKey].promptTokens += log.promptTokens;
      phaseStatsMap[phaseKey].completionTokens += log.completionTokens;
      phaseStatsMap[phaseKey].callCount += 1;

      // Scenario Map
      const label = SCENARIO_LABELS[source] || '通用 LLM 处理';
      if (!scenarioStatsMap[source]) {
        scenarioStatsMap[source] = {
          label,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          callCount: 0,
        };
      }
      scenarioStatsMap[source].totalTokens += log.totalTokens;
      scenarioStatsMap[source].promptTokens += log.promptTokens;
      scenarioStatsMap[source].completionTokens += log.completionTokens;
      scenarioStatsMap[source].callCount += 1;
    }

    const tutorialBreakdown: TutorialBreakdownItem[] = Object.entries(tutorialStatsMap)
      .map(([repositoryId, stats]) => {
        const repoTotal = stats.totalTokens;
        const phases: TutorialPhaseStat[] = (['import', 'transcription', 'chat', 'indexing'] as PhaseKey[]).map(pk => {
          const pStat = stats.phaseTokens[pk];
          return {
            phaseKey: pk,
            label: PHASE_DEFINITIONS[pk].label,
            totalTokens: pStat.totalTokens,
            percentage: repoTotal > 0 ? Math.round((pStat.totalTokens / repoTotal) * 100) : 0,
            callCount: pStat.callCount,
          };
        });

        return {
          repositoryId,
          repoName: stats.repoName,
          totalTokens: stats.totalTokens,
          promptTokens: stats.promptTokens,
          completionTokens: stats.completionTokens,
          percentage: totalTokens > 0 ? Math.round((stats.totalTokens / totalTokens) * 100) : 0,
          callCount: stats.callCount,
          phases,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const phaseBreakdown: PhaseBreakdownItem[] = (['import', 'transcription', 'chat', 'indexing'] as PhaseKey[]).map(pk => {
      const stats = phaseStatsMap[pk];
      const def = PHASE_DEFINITIONS[pk];
      return {
        phaseKey: pk,
        label: def.label,
        description: def.description,
        totalTokens: stats.totalTokens,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        percentage: totalTokens > 0 ? Math.round((stats.totalTokens / totalTokens) * 100) : 0,
        callCount: stats.callCount,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

    const scenarioBreakdown: ScenarioBreakdownItem[] = Object.entries(scenarioStatsMap)
      .map(([source, stats]) => ({
        source,
        label: stats.label,
        totalTokens: stats.totalTokens,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        percentage: totalTokens > 0 ? Math.round((stats.totalTokens / totalTokens) * 100) : 0,
        callCount: stats.callCount,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const importTokens = phaseStatsMap['import'].totalTokens;
    const transcriptionTokens = phaseStatsMap['transcription'].totalTokens;
    const chatTokens = phaseStatsMap['chat'].totalTokens;
    const indexingTokens = phaseStatsMap['indexing'].totalTokens;

    return {
      summary: {
        totalTokens,
        promptTokens,
        completionTokens,
        tutorialCount: tutorialBreakdown.filter((t) => t.repositoryId !== 'global').length,
        importTokens,
        importPercentage: totalTokens > 0 ? Math.round((importTokens / totalTokens) * 100) : 0,
        transcriptionTokens,
        transcriptionPercentage: totalTokens > 0 ? Math.round((transcriptionTokens / totalTokens) * 100) : 0,
        chatTokens,
        chatPercentage: totalTokens > 0 ? Math.round((chatTokens / totalTokens) * 100) : 0,
        indexingTokens,
        indexingPercentage: totalTokens > 0 ? Math.round((indexingTokens / totalTokens) * 100) : 0,
      },
      tutorialBreakdown,
      phaseBreakdown,
      scenarioBreakdown,
    };
  }
}

export interface TrackTokenUsageOptions {
  userId?: string;
  source?: string;
  model?: string;
  provider?: string;
  repositoryId?: string;
  conversationId?: string;
  messageId?: string;
}

/**
 * Top-level zero-boilerplate helper for logging LLM token usage asynchronously.
 * Usage: `trackTokenUsage(result.usage, { source: 'indexer' })`
 * 无真实 userId 时跳过落库(见 logUsage 守卫)——不再用 'system' 占位,
 * 那会导致 TokenUsageLog_userId_fkey 外键违反(P2003 控制台噪声)。
 */
export function trackTokenUsage(usage: any, options: TrackTokenUsageOptions = {}) {
  if (!usage) return;
  const userId = options.userId?.trim();
  if (!userId) return;
  TokenUsageService.logSDKResult(userId, usage, options);
}

