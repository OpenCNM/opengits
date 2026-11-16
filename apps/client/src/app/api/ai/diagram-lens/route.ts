import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { getModel, generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { sanitizeMermaid, ensureQuotedMermaidLabels } from '@/lib/mermaid/resilience';

const DiagramLensPayloadSchema = z.object({
  chart: z.string().min(1),
  targetDepth: z.enum(['standard', 'deep']),
  title: z.string().optional(),
  userPrompt: z.string().max(200).optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/ai/diagram-lens',
  auth: 'user',
  bodySchema: DiagramLensPayloadSchema,
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.diagramLensMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.diagramLensWindowMs,
    identifier: ({ userId }) => 'diagram_lens_' + userId,
  },
  handler: async ({ body, userId, locale }) => {
    if (!userId) {
      throw ApiError.unauthorized();
    }

    const userModel = await resolveActiveUserModel(userId);
    if (!userModel) {
      throw ApiError.badRequest('未配置或未激活 AI 服务商 API Key，请先在设置中配置您的自备 API Key。', {
        code: 'MISSING_API_KEY',
      });
    }

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

    const depthInstructions =
      body.targetDepth === 'standard'
        ? `DEPTH INSTRUCTIONS (STANDARD - 机制数据流 / 进阶):
1. The diagram MUST start with \`flowchart LR\`.
2. Expand the diagram into a clean unidirectional horizontal dataflow/architecture diagram showing component responsibilities and data flow payloads.
3. Annotate connectors with data payloads or messages (e.g. \`-->|"payload / event"|\`).
4. Avoid circular clutter or messy overlapping lines.`
        : `DEPTH INSTRUCTIONS (DEEP - 源码架构 / 深度):
1. The diagram MUST start with \`flowchart TB\` or \`flowchart LR\`.
2. Expand into structured \`subgraph\` blocks representing system layers, state boundaries, or lifecycle mechanics (e.g. \`subgraph IngestEngine ["Ingestion & Parsing Layer"]\`).
3. Detail internal state transitions, background worker loops, and boundary failure paths.
4. Keep connections structured and directional without unstructured messy criss-cross lines.`;

    const compiled = await PromptRegistry.getCompiledPrompt('diagram_lens', {
      chart: body.chart,
      title: body.title || '',
      targetDepth: body.targetDepth,
      depthInstructions,
      userPrompt: body.userPrompt ? `User Focus Note:\n${body.userPrompt}` : '',
      targetLanguage: locale || 'zh-CN',
    });

    try {
      const result = await generateStructured({
        model,
        userId,
        temperature: compiled.modelConfig?.temperature ?? 0.2,
        schema: z.object({
          mermaidCode: z.string().describe('The transformed valid Mermaid diagram code'),
        }),
        prompt: compiled.compiledPrompt,
        source: 'diagram_lens',
      });

      trackTokenUsage(result.usage, {
        userId,
        source: 'diagram_lens',
        model: userModel.modelId,
        provider: userModel.provider,
      });

      const cleaned = sanitizeMermaid(result.object.mermaidCode);
      const mermaidCode = ensureQuotedMermaidLabels(cleaned);

      return ok({
        ok: true,
        mermaidCode,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === 'BudgetExceededError') {
        throw ApiError.tooManyRequests('平台今日 AI 额度已用尽，请明日再试或配置你自己的 API Key');
      }
      console.warn('[DiagramLens] LLM generation failed:', err);
      throw ApiError.internal('生成深度架构图失败，请稍后重试');
    }
  },
});
