import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError, toApiErrorFromLlm } from '@/lib/api/server/api-error';
import { ENGINE_CONFIG } from '@/lib/config';
import {
  resolveGenerativeLanguage,
  REORGANIZE_CATEGORY_INTENT_IDS,
  REORGANIZE_SHORT_LABEL_MAX,
} from '@/lib/constants';
import { REORGANIZE_CATEGORY_INTENTS } from '@/lib/prompt-presets';
import { resolveUserModelWithKeyStatus, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { getModel, generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';

const OutlineExpandItemSchema = z.object({
  partTitle: z.string().max(150).optional(),
  title: z.string().min(1).max(200),
  files: z.array(z.string().max(300)).max(12).optional(),
});

const ExpandOutlinePromptSchema = z.object({
  userInput: z.string().max(1000).optional().default(''),
  repoSlug: z.string().max(200).optional().default(''),
  domain: z.string().max(100).optional().default(''),
  tags: z.array(z.string().max(60)).max(20).optional().default([]),
  scopePrefix: z.string().max(300).optional().default(''),
  targetLanguage: z.string().max(40).optional(),
  categoryIntent: z.enum(REORGANIZE_CATEGORY_INTENT_IDS).optional().default('general'),
  outline: z.array(OutlineExpandItemSchema).min(1).max(60),
});

function buildOutlineSummary(outline: Array<z.infer<typeof OutlineExpandItemSchema>>): string {
  const lines: string[] = [];
  let lastPart = '';

  outline.forEach((chapter, index) => {
    const part = chapter.partTitle?.trim() || '';
    if (part && part !== lastPart) {
      lines.push(`[${part}]`);
      lastPart = part;
    }
    const filesHint =
      chapter.files && chapter.files.length > 0
        ? ` (files: ${chapter.files.slice(0, 6).join(', ')})`
        : '';
    lines.push(`${index + 1}. ${chapter.title.trim()}${filesHint}`);
  });

  return lines.join('\n');
}

function stripWrappingQuotes(s: string): string {
  return s.trim().replace(/^["'「『]|["'」』]$/g, '');
}

function normalizeShortLabel(raw: string, expandedPrompt: string): string {
  let s = stripWrappingQuotes(raw);
  if (!s) {
    s = stripWrappingQuotes(expandedPrompt.split(/[；;。.!！?？\n]/).find((seg) => seg.trim()) ?? '');
  }
  if (!s) s = expandedPrompt;
  return s.slice(0, REORGANIZE_SHORT_LABEL_MAX);
}

export const POST = defineRoute({
  scope: 'POST /api/ai/expand-outline-prompt',
  auth: 'user',
  bodySchema: ExpandOutlinePromptSchema,
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.outlineExpandMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.outlineExpandWindowMs,
    identifier: ({ userId }) => 'outline_expand_' + userId,
  },
  handler: async ({ body, userId, locale }) => {
    if (!userId) {
      throw ApiError.unauthorized();
    }

    const keyResolution = await resolveUserModelWithKeyStatus(userId);
    if (!keyResolution.ok) {
      throw ApiError.fromCode(keyResolution.code);
    }
    const userModel = keyResolution.model;

    const model =
      toInjectableStructuredModel(userModel) ||
      getModel(userModel.provider, userModel.modelId, {
        apiKey: userModel.apiKey,
        baseURL: userModel.baseURL,
        apiFormat: userModel.apiFormat,
      });

    if (!model) {
      throw ApiError.badRequest('当前激活的服务商配置无效，请检查设置。', {
        code: 'MISSING_API_KEY',
      });
    }

    const targetLanguage = resolveGenerativeLanguage(body.targetLanguage, locale || 'zh-CN');
    const trimmedInput = body.userInput.trim();
    const userInputSection = trimmedInput
      ? trimmedInput
      : '(Empty — analyze the current outline skeleton and propose one concise, high-impact reorganization instruction.)';

    const compiled = await PromptRegistry.getCompiledPrompt('outline_prompt_expand', {
      targetLanguage,
      categoryIntent: REORGANIZE_CATEGORY_INTENTS[body.categoryIntent],
      repoSlug: body.repoSlug.trim() || 'Unknown Repository',
      domain: body.domain.trim() || 'General',
      tags: body.tags.length > 0 ? body.tags.map((t) => `#${t}`).join(' ') : 'None',
      scopePrefix: body.scopePrefix.trim() || '(Full repository)',
      outlineSummary: buildOutlineSummary(body.outline),
      userInputSection,
    });

    try {
      const result = await generateStructured({
        model,
        userId,
        temperature: compiled.modelConfig?.temperature ?? 0.35,
        ...(compiled.modelConfig?.maxTokens ? { maxTokens: compiled.modelConfig.maxTokens } : {}),
        disableThinking: true,
        schema: z.object({
          shortLabel: z.string().max(120).catch('').describe('Menu-friendly short tag'),
          expandedPrompt: z.string().min(1).describe('Concise, grounded reorganization instruction'),
        }),
        prompt: compiled.compiledPrompt,
        source: 'outline_prompt_expand',
      });

      trackTokenUsage(result.usage, {
        userId,
        source: 'outline_prompt_expand',
        model: userModel.modelId,
        provider: userModel.provider,
      });

      const expandedPrompt = stripWrappingQuotes(result.object.expandedPrompt);
      if (!expandedPrompt) {
        throw ApiError.internal('AI 扩写结果为空，请重试');
      }

      return ok({
        ok: true,
        shortLabel: normalizeShortLabel(result.object.shortLabel, expandedPrompt),
        expandedPrompt,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      console.warn('[OutlinePromptExpand] LLM generation failed:', err);
      throw toApiErrorFromLlm(err, 'AI 扩写失败，请稍后重试', {
        provider: userModel.provider,
        model: userModel.modelId,
      });
    }
  },
});
