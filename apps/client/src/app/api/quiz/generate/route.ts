import { z } from 'zod';
import { ENGINE_CONFIG } from '@/lib/config';
import { modelName, trackTokenUsage, generateStructured } from '@/lib/ai';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { checkRepositoryAccess } from '@/lib/auth-utils';
import { QUIZ_DIFFICULTIES, QuizDifficulty } from '@/lib/constants';
import { PromptRegistry } from '@/lib/prompt-registry';

export const quizGenerationSchema = z.object({
  quizzes: z
    .array(
      z.object({
        question: z.string(),
        options: z
          .array(z.string())
          .length(4)
          .refine((arr) => new Set(arr).size === arr.length, {
            message: 'options must be unique',
          }),
        correctIndex: z.number().min(0).max(3),
        explanation: z.string(),
        difficulty: z.enum(['easy', 'medium', 'hard']).default('medium').optional(),
      })
    )
    .min(1)
    .max(3),
});

export const POST = defineRoute({
  scope: 'POST /api/quiz/generate',
  auth: 'user',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.quizMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.quizWindowMs,
    identifier: ({ userId }) => 'quiz_gen_' + userId,
  },
  handler: async ({ request, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    // 保持原校验语义：content 仅做真值检查，difficulty 不限定枚举（未知值回落自适应提示词）
    const {
      content,
      documentId,
      contentId,
      difficulty = QUIZ_DIFFICULTIES.ADAPTIVE,
      repositoryId,
      enableThinking = false,
    } = await request.json();

    // ── 内容寻址快照路径（性能修复 2026-10-13）──
    // 此前客户端把整章 MDX 原文二次序列化进 RSC payload 传给本端；改传
    // (documentId, contentId)——服务端自取不可变 DocumentContent 行：
    // - contentId 为读者正在读的版本快照（activeVersion?.contentId ?? doc.contentId），
    //   与旧「读页快照」语义严格等价且不受换版本/翻正影响；
    // - 归属校验：contentId 必须是 document 基底指针或该文档的 ChapterVersion；
    // - 权限校验升级为强制（旧路径 repositoryId 由客户端传入，可缺省）。
    // 旧 content 路径保留（部署窗口期的旧客户端 bundle 与既有测试依赖）。
    let effectiveContent = typeof content === 'string' ? content : '';
    let accessRepositoryId: string | undefined = repositoryId;

    if (documentId) {
      const { prisma } = await import('@/lib/db');
      const document = await prisma.document
        .findUnique({
          where: { id: documentId },
          select: { repositoryId: true, contentId: true, content: true },
        })
        .catch(() => null);
      if (!document) {
        throw ApiError.badRequest('Document not found');
      }
      accessRepositoryId = document.repositoryId;

      let resolvedContentId: string | null = null;
      if (contentId && contentId !== document.contentId) {
        // 非基底指针：校验存在该 documentId+contentId 的章节版本
        const version = await prisma.chapterVersion
          .findFirst({
            where: { documentId, contentId },
            select: { id: true },
          })
          .catch(() => null);
        resolvedContentId = version ? contentId : null;
      } else {
        resolvedContentId = contentId ?? document.contentId ?? null;
      }

      if (resolvedContentId) {
        const contentRow = await prisma.documentContent
          .findUnique({
            where: { id: resolvedContentId },
            select: { content: true },
          })
          .catch(() => null);
        if (contentRow?.content) {
          effectiveContent = contentRow.content;
        }
      }
      // 内容层行缺失/悬空：回落基底行正文（legacy 无内容层文档）
      if (!effectiveContent && document.content) {
        effectiveContent = document.content;
      }
    }

    if (accessRepositoryId) {
      const hasAccess = await checkRepositoryAccess(accessRepositoryId, userId);
      if (!hasAccess) {
        throw ApiError.forbidden('Forbidden');
      }
    }

    if (!effectiveContent) {
      throw ApiError.badRequest('Content required');
    }

    const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    const userModel = await resolveActiveUserModel(userId);
    if (!userModel) {
      throw ApiError.badRequest('未配置或未激活 AI 服务商 API Key，请先在设置中配置您的自备 API Key。', {
        code: 'MISSING_API_KEY',
      });
    }
    const model = toInjectableStructuredModel(userModel);
    if (!model) {
      throw ApiError.badRequest('当前激活的服务商配置无效或不支持 OpenAI 格式，请检查设置。', {
        code: 'MISSING_API_KEY',
      });
    }

    const targetDifficulty = (difficulty as QuizDifficulty) || QUIZ_DIFFICULTIES.ADAPTIVE;

    const compiled = await PromptRegistry.getCompiledPrompt('quiz_generation', {
      difficulty: targetDifficulty,
      content: effectiveContent,
    });

    try {
      const isThinkingEnabled = Boolean(enableThinking);
      const result = await generateStructured({
        model,
        userId,
        temperature: compiled.modelConfig?.temperature ?? 0.7,
        schema: quizGenerationSchema,
        prompt: compiled.compiledPrompt,
        disableThinking: !isThinkingEnabled,
        enableThinking: isThinkingEnabled,
        maxTokens: isThinkingEnabled ? 8000 : 1200,
      });

      trackTokenUsage(result.usage, {
        userId,
        source: 'tutor_explanation',
        model: modelName,
        provider: 'dashscope',
      });

      return ok(result.object);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'BudgetExceededError') {
        throw ApiError.tooManyRequests('平台今日 AI 额度已用尽，请明日再试或配置你自己的 API Key', {
          code: 'BUDGET_EXCEEDED',
        });
      }
      if (
        error instanceof Error &&
        (error.name === 'MissingApiKeyError' || error.message.includes('MISSING_API_KEY'))
      ) {
        throw ApiError.badRequest(error.message, {
          code: 'MISSING_API_KEY',
        });
      }
      if (error instanceof ApiError) {
        throw error;
      }
      // 严格失效封闭（346准则·公理5）：坚决拒绝返回伪弹性 unavailable: true 欺瞒前端
      console.warn('[QuizGenerate] Generation failed, fail-closed:', error);
      throw ApiError.internal('测验题目生成未能通过结构化校验，请点击重试', {
        code: 'GENERATION_FAILED',
      });
    }
  },
});
