import { z } from 'zod';
import { ENGINE_CONFIG } from '@/lib/config';
import { modelName, trackTokenUsage, generateStructured } from '@/lib/ai';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError, toApiErrorFromLlm } from '@/lib/api/server/api-error';
import { checkRepositoryAccess } from '@/lib/auth-utils';
import { QUIZ_DIFFICULTIES, QuizDifficulty } from '@/lib/constants';
import { stripDeepDiveBlocks } from '@/lib/mdx/prepareMdxSource';
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
    if (!userId) throw ApiError.unauthorized();

    const {
      content,
      documentId,
      contentId,
      difficulty = QUIZ_DIFFICULTIES.ADAPTIVE,
      repositoryId,
      enableThinking = false,
    } = await request.json();

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

    const { resolveUserModelWithKeyStatus, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    const keyResolution = await resolveUserModelWithKeyStatus(userId);
    if (!keyResolution.ok) {
      throw ApiError.fromCode(keyResolution.code);
    }
    const userModel = keyResolution.model;
    const model = toInjectableStructuredModel(userModel);
    if (!model) {
      throw ApiError.badRequest('当前激活的服务商配置无效或不支持 OpenAI 格式，请检查设置。', {
        code: 'MISSING_API_KEY',
      });
    }

    const targetDifficulty = (difficulty as QuizDifficulty) || QUIZ_DIFFICULTIES.ADAPTIVE;
    const strippedContent = stripDeepDiveBlocks(effectiveContent);
    const quizContent = strippedContent.trim() ? strippedContent : effectiveContent;

    const compiled = await PromptRegistry.getCompiledPrompt('quiz_generation', {
      difficulty: targetDifficulty,
      content: quizContent,
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
      if (error instanceof ApiError) {
        throw error;
      }
      console.warn('[QuizGenerate] Generation failed, fail-closed:', error);
      throw toApiErrorFromLlm(error, '测验题目生成未能通过结构化校验，请点击重试', {
        provider: userModel.provider,
        model: userModel.modelId,
      });
    }
  },
});
