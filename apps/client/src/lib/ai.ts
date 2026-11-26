import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fetch as nativeFetch } from 'undici';
import { generateObject, generateText, streamText } from 'ai';
import { z } from 'zod';

import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL, AI_PROVIDER_PRESETS } from '@/lib/constants';
import * as m from '@/paraglide/messages';
import { trackTokenUsage } from '@/lib/analytics/token-usage';
import { buildThinkingProviderOptions } from '@/lib/llm-gateway/thinking-adapter';
import { ignoreBestEffort } from '@/lib/best-effort';
import { extractUpstreamError, isUpstreamCallFailure } from '@/lib/llm-gateway/upstream-error';
import { fastExtractJsonObject, fastSalvageJson, repairStructuredJsonViaLlm } from '@/lib/ai/salvage-structured';

export class MissingApiKeyError extends Error {
  constructor(message = '未配置或未激活 AI 服务商 API Key，请先在个人偏好设置中配置您的自备 API Key。') {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

async function buildMissingApiKeyMessage(
  fnName: string,
  opts: { userId?: string | null; providerKey: string; modelId?: string }
): Promise<string> {
  if (opts.userId) {
    try {
      const mod = await import('@/lib/ai/user-model-resolver');
      if (typeof mod.inspectUserModelKeyStatus === 'function') {
        const info = await mod.inspectUserModelKeyStatus(opts.userId);
        if (info.status === 'decrypt_failed') {
          return `${fnName}: ${m.toast_key_decrypt_failed()} (provider=${info.provider || opts.providerKey}, model=${info.modelId || opts.modelId || defaultEngineModel})`;
        }
        if (info.status === 'missing') {
          return `${fnName}: ${m.toast_missing_api_key()}`;
        }
      }
    } catch (err) {
      console.warn(`[ai] inspectUserModelKeyStatus failed in ${fnName}:`, err);
    }
  }
  return `${fnName}: ${m.toast_missing_api_key()} (provider=${opts.providerKey}, model=${opts.modelId || defaultEngineModel})`;
}

export const modelName = DEFAULT_AI_MODEL;

interface DynamicModelOptions {
  provider?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
  apiFormat?: 'openai' | 'anthropic';
}

export function getDynamicModel(options: DynamicModelOptions) {
  const { provider, modelId = DEFAULT_AI_MODEL, apiKey: customKey, baseURL: customBaseUrl, apiFormat = 'openai' } = options;

  if (customKey && customKey.trim()) {
    let cleanBaseUrl = (customBaseUrl || '').trim().replace(/\/+$/, '');
    if (!cleanBaseUrl && provider && provider in AI_PROVIDER_PRESETS) {
      cleanBaseUrl = (AI_PROVIDER_PRESETS[provider]?.baseUrl || '').trim().replace(/\/+$/, '');
    }
    if (apiFormat === 'openai' || !apiFormat) {
      // Bypass Next.js globalThis.fetch SSE buffering with undici native fetch; custom baseURLs use openai-compatible so reasoning_content deltas are preserved.
      const nativeFetchTyped = (async (...a: Parameters<typeof globalThis.fetch>) => {
        const res = await (nativeFetch as any)(...a);
        return res;
      }) as unknown as typeof globalThis.fetch;
      if (cleanBaseUrl) {
        const compatible = createOpenAICompatible({
          name: 'compatible',
          apiKey: customKey.trim(),
          baseURL: cleanBaseUrl,
          fetch: nativeFetchTyped,
          supportsStructuredOutputs: true,
        });
        return compatible(modelId);
      }
      const customOpenAI = createOpenAI({
        apiKey: customKey.trim(),
        fetch: nativeFetchTyped,
      });
      return customOpenAI.chat(modelId);
    }
  }

  throw new MissingApiKeyError(
    `调用 AI 模型 [${modelId}] 需要配置 API Key，未检测到有效的用户 Key (provider=${provider || 'custom'})。`
  );
}

export function getModel(
  provider: 'dashscope' | 'deepseek' | string,
  modelId: string,
  customOptions?: { apiKey?: string; baseURL?: string; apiFormat?: 'openai' | 'anthropic' }
) {
  if (customOptions?.apiKey && customOptions.apiKey.trim()) {
    return getDynamicModel({
      provider,
      modelId,
      apiKey: customOptions.apiKey,
      baseURL: customOptions.baseURL,
      apiFormat: customOptions.apiFormat,
    });
  }

  throw new MissingApiKeyError(
    `调用 AI 模型 [${modelId}] 需要配置 API Key，未检测到有效的用户 Key。`
  );
}

export const defaultEngineProvider = (process.env.DEFAULT_ENGINE_PROVIDER as 'dashscope' | 'deepseek') || DEFAULT_AI_PROVIDER;
export const defaultEngineModel = process.env.DEFAULT_ENGINE_MODEL || DEFAULT_AI_MODEL;

type LanguageModelLike = Parameters<typeof generateObject>[0]['model'];

// Process-wide cache of providers that reject response_format: json_schema, skipping repeat failed attempts.
const jsonSchemaUnsupportedProviders = new Set<string>();

export interface GenerateStructuredOptions<T> {
  schema: z.ZodType<T>;
  normalizeOutput?: (raw: unknown) => unknown;
  prompt: string;
  provider?: 'deepseek' | 'dashscope' | (string & {});
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  model?: LanguageModelLike;
  userId?: string | null;
  keyOrigin?: 'platform' | 'user';
  source?: string;
  disableThinking?: boolean;
  enableThinking?: boolean;
  abortSignal?: AbortSignal;
}

interface GenerateStructuredResult<T> {
  object: T;
  usage: unknown;
  mode: 'json_schema' | 'json_mode';
  finishReason?: unknown;
}

type ProviderOptionsLike = Parameters<typeof generateText>[0]['providerOptions'];

function resolveModelInfo(opts: { modelId?: string; provider?: string; model?: LanguageModelLike }): { modelId?: string; provider?: string } {
  const modelAny = opts.model as any;
  const modelId = opts.modelId || modelAny?.modelId || modelAny?.id || undefined;
  const provider = opts.provider || modelAny?.provider || undefined;
  return { modelId, provider };
}

function isThinkingParamCompat400(err: unknown, providerKey: string, modelId?: string): boolean {
  const upstream = extractUpstreamError(err, {
    provider: providerKey,
    model: modelId || defaultEngineModel,
  });
  return (
    upstream.code === 'UPSTREAM_BAD_REQUEST' &&
    /reasoning_effort|reasoningEffort|enable_thinking|thinking.*budget|始终思考|不支持关闭思考/i.test(upstream.message)
  );
}

function resolveProviderOptions(
  opts: {
    disableThinking?: boolean;
    enableThinking?: boolean;
    modelId?: string;
    provider?: string;
    model?: LanguageModelLike;
  },
  modelObj?: LanguageModelLike
): ProviderOptionsLike {
  const effectiveModel = modelObj || opts.model;
  const { modelId, provider } = resolveModelInfo({ ...opts, model: effectiveModel });
  return buildThinkingProviderOptions({
    modelId,
    provider,
    disableThinking: opts.disableThinking,
    enableThinking: opts.enableThinking,
  }) as ProviderOptionsLike;
}

// JSON-mode fallback feeds Zod validation issues back to the model because json_object does not enforce schema fields server-side.
async function generateStructuredViaJsonMode<T>(
  opts: GenerateStructuredOptions<T>,
  model: LanguageModelLike
): Promise<GenerateStructuredResult<T>> {
  const { schema, prompt, provider, temperature } = opts;

  let schemaHint = '';
  try {
    let jsonSchema: unknown;
    try {
      jsonSchema = z.toJSONSchema(schema);
    } catch {
      ignoreBestEffort();
      jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    }
    schemaHint = jsonSchema ? `\n\n输出 JSON 必须严格符合以下结构（字段齐全，类型一致）:\n${JSON.stringify(jsonSchema)}` : '';
  } catch {
    ignoreBestEffort();
  }

  const MAX_JSON_MODE_RETRIES = 2;
  let lastText = '';
  let lastIssues: unknown = null;
  let lastUsage: unknown = undefined;
  let lastFinishReason: unknown = undefined;
  const providerOptions = resolveProviderOptions(opts, model);
  for (let attempt = 0; attempt <= MAX_JSON_MODE_RETRIES; attempt++) {
    const feedback = attempt === 0
      ? ''
      : `\n\n上次输出不符合要求：${JSON.stringify(lastIssues)}\n上次输出：\n${lastText}\n请修正后只输出一个 JSON 对象（字段齐全、类型正确）。`;
    const textResult = await generateText({
      model,
      prompt: `${prompt}\n\n必须只输出一个 JSON 对象：不要 Markdown 代码块、不要任何额外说明文字。${schemaHint}${feedback}`,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
    lastUsage = textResult.usage;
    lastText = textResult.text;
    lastFinishReason = textResult.finishReason;

    const extracted = opts.normalizeOutput ? fastExtractJsonObject(lastText) : undefined;
    if (extracted !== undefined && opts.normalizeOutput) {
      const normalized = opts.normalizeOutput(extracted);
      const checked = schema.safeParse(normalized);
      if (checked.success) {
        return { object: checked.data, usage: lastUsage, mode: 'json_mode', finishReason: lastFinishReason };
      }
      lastIssues = checked.error.issues;
    }

    const salvaged = fastSalvageJson(lastText, schema);
    if (salvaged !== null) {
      return { object: salvaged, usage: lastUsage, mode: 'json_mode', finishReason: lastFinishReason };
    }

    const jsonMatch = lastText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const rawParsed = JSON.parse(jsonMatch[0]);
        const parsed = opts.normalizeOutput ? opts.normalizeOutput(rawParsed) : rawParsed;
        const safe = schema.safeParse(parsed);
        if (safe.success) {
          return { object: safe.data, usage: lastUsage, mode: 'json_mode', finishReason: lastFinishReason };
        }
        lastIssues = safe.error.issues;
      } catch (parseErr) {
        lastIssues = `JSON parse error: ${String(parseErr)}`;
      }
    } else {
      lastIssues = 'No JSON container found in model output';
    }
  }

  if (lastText) {
    try {
      const repaired = await repairStructuredJsonViaLlm(
        lastText,
        schema,
        typeof lastIssues === 'string' ? lastIssues : JSON.stringify(lastIssues),
        model,
        opts.abortSignal
      );
      if (repaired !== null) {
        return { object: repaired, usage: lastUsage, mode: 'json_mode', finishReason: lastFinishReason };
      }
    } catch {
      ignoreBestEffort();
    }
  }

  throw new Error(`generateStructured: JSON mode 降级失败（${MAX_JSON_MODE_RETRIES + 1} 次尝试均未通过 schema 校验，provider=${provider || defaultEngineProvider}）`);
}

export interface GenerateCompletionTextOptions {
  prompt: string;
  provider?: 'deepseek' | 'dashscope' | (string & {});
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  model?: LanguageModelLike;
  userId?: string | null;
  keyOrigin?: 'platform' | 'user';
  source?: string;
  disableThinking?: boolean;
  enableThinking?: boolean;
  abortSignal?: AbortSignal;
}

interface GenerateCompletionTextResult {
  text: string;
  usage: unknown;
  finishReason: unknown;
}

// Unconstrained text completion sharing gateway routing and budget gates for sentinel-wrapped markdown outputs.
export async function generateCompletionText(opts: GenerateCompletionTextOptions): Promise<GenerateCompletionTextResult> {
  const { provider, modelId, temperature } = opts;
  const providerKey = provider || defaultEngineProvider;

  let model = opts.model;
  if (!model && opts.userId) {
    try {
      const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
      const userModel = await resolveActiveUserModel(opts.userId);
      model = toInjectableStructuredModel(userModel);
    } catch (err) {
      console.warn('[ai] resolveActiveUserModel failed, falling back to default model:', err);
    }
  }

  if (!model) {
    throw new MissingApiKeyError(
      await buildMissingApiKeyMessage('generateCompletionText', { userId: opts.userId, providerKey, modelId })
    );
  }

  const { checkLlmBudget } = await import('@/lib/llm-budget');
  await checkLlmBudget({ userId: opts.userId ?? null, keyOrigin: opts.keyOrigin ?? 'user', source: opts.source });

  const providerOptions = resolveProviderOptions(opts, model);
  const runGenerateText = (withProviderOpts: boolean) =>
    generateText({
      model,
      prompt: opts.prompt,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(withProviderOpts && providerOptions ? { providerOptions } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });

  let result;
  try {
    result = await runGenerateText(true);
  } catch (err) {
    if (providerOptions && isThinkingParamCompat400(err, providerKey, modelId)) {
      result = await runGenerateText(false);
    } else {
      throw err;
    }
  }
  return { text: result.text, usage: result.usage, finishReason: result.finishReason };
}

interface StreamCompletionTextResult {
  // textStream omits reasoning deltas; streaming watchdogs must observe fullStream so thinking models are not misclassified as stalled.
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<{ type: string; text?: string; delta?: string; id?: string; error?: unknown }>;
  finishReason: Promise<unknown>;
  usage: Promise<unknown>;
  // Capture AI SDK onError payload before fullStream collapses to NoOutputGeneratedError.
  getStreamError?: () => unknown;
}

export async function streamCompletionText(
  opts: GenerateCompletionTextOptions
): Promise<StreamCompletionTextResult> {
  const { provider, modelId, temperature } = opts;
  const providerKey = provider || defaultEngineProvider;

  let model = opts.model;
  if (!model && opts.userId) {
    try {
      const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
      const userModel = await resolveActiveUserModel(opts.userId);
      model = toInjectableStructuredModel(userModel);
    } catch (err) {
      console.warn('[ai] resolveActiveUserModel failed, falling back to default model:', err);
    }
  }

  if (!model) {
    throw new MissingApiKeyError(
      await buildMissingApiKeyMessage('streamCompletionText', { userId: opts.userId, providerKey, modelId })
    );
  }

  const { checkLlmBudget } = await import('@/lib/llm-budget');
  await checkLlmBudget({ userId: opts.userId ?? null, keyOrigin: opts.keyOrigin ?? 'user', source: opts.source });

  const providerOptions = resolveProviderOptions(opts, model);
  let capturedStreamError: unknown = null;
  const result = streamText({
    model,
    prompt: opts.prompt,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    onError({ error }) {
      capturedStreamError = error;
      console.error(`[ai] streamText upstream error (provider=${providerKey}, model=${modelId || defaultEngineModel}):`, error);
    },
    onFinish({ usage }) {
      if (opts.userId) {
        trackTokenUsage(usage, {
          userId: opts.userId,
          source: opts.source || 'tutor_explanation',
          model: modelId || defaultEngineModel,
          provider: providerKey,
        });
      }
    },
  });

  return {
    textStream: result.textStream,
    fullStream: result.fullStream,
    finishReason: Promise.resolve(result.finishReason),
    usage: Promise.resolve(result.usage),
    getStreamError: () => capturedStreamError,
  };
}

export async function generateStructured<T>(opts: GenerateStructuredOptions<T>): Promise<GenerateStructuredResult<T>> {
  const { schema, prompt, provider, modelId, temperature } = opts;
  const providerKey = provider || defaultEngineProvider;

  let model = opts.model;
  if (!model && opts.userId) {
    try {
      const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
      const userModel = await resolveActiveUserModel(opts.userId);
      model = toInjectableStructuredModel(userModel);
    } catch (err) {
      console.warn('[ai] resolveActiveUserModel failed, falling back to default model:', err);
    }
  }

  if (!model) {
    throw new MissingApiKeyError(
      await buildMissingApiKeyMessage('generateStructured', { userId: opts.userId, providerKey, modelId })
    );
  }

  const { checkLlmBudget } = await import('@/lib/llm-budget');
  await checkLlmBudget({ userId: opts.userId ?? null, keyOrigin: opts.keyOrigin ?? 'user', source: opts.source });

  if (jsonSchemaUnsupportedProviders.has(providerKey)) {
    return generateStructuredViaJsonMode(opts, model);
  }

  const providerOptions = resolveProviderOptions(opts, model);
  const runGenerateObject = (withProviderOpts: boolean) =>
    generateObject({
      model,
      schema,
      prompt,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(withProviderOpts && providerOptions ? { providerOptions } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });

  try {
    let result;
    try {
      result = await runGenerateObject(true);
    } catch (firstErr) {
      if (providerOptions && isThinkingParamCompat400(firstErr, providerKey, modelId)) {
        result = await runGenerateObject(false);
      } else {
        throw firstErr;
      }
    }
    const candidateObj = opts.normalizeOutput ? opts.normalizeOutput(result.object) : result.object;
    // JSON Schema cannot express Zod .refine() constraints; re-validate and route failures into json_mode retry.
    const checked = schema.safeParse(candidateObj);
    if (!checked.success) {
      return generateStructuredViaJsonMode(opts, model);
    }
    return { object: checked.data, usage: result.usage, mode: 'json_schema', finishReason: result.finishReason };
  } catch (err) {
    const upstream = extractUpstreamError(err, {
      provider: providerKey,
      model: modelId || defaultEngineModel,
    });
    // Rethrow upstream HTTP/auth/quota/rate-limit/network errors fail-closed; only format-compat 400s fall back to json_mode.
    const isFormatCompat400 =
      upstream.code === 'UPSTREAM_BAD_REQUEST' &&
      /response_format|json_schema|始终思考|不支持关闭思考/i.test(upstream.message);
    if (isUpstreamCallFailure(upstream) && !isFormatCompat400) {
      throw err;
    }

    const msg = String((err as Error)?.message || err);
    if (!isFormatCompat400 && !/response_format|json_schema|no object generated|could not parse|syntaxerror|始终思考|不支持关闭思考/i.test(msg)) {
      throw err;
    }

    jsonSchemaUnsupportedProviders.add(providerKey);
    return generateStructuredViaJsonMode(opts, model);
  }
}

export { trackTokenUsage } from '@/lib/analytics/token-usage';

