import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fetch as nativeFetch } from 'undici';
import { generateObject, generateText, streamText } from 'ai';
import { z } from 'zod';

import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL, AI_PROVIDER_PRESETS } from '@/lib/constants';
import { trackTokenUsage } from '@/lib/analytics/token-usage';
import { buildThinkingProviderOptions } from '@/lib/llm-gateway/thinking-adapter';
import { fastSalvageJson, repairStructuredJsonViaLlm } from '@/lib/ai/salvage-structured';

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
          return `${fnName}: 云端已保存的 AI 密钥无法解密（可能因环境密钥变更失效），请在偏好设置中重新填写并保存 API Key (provider=${info.provider || opts.providerKey}, model=${info.modelId || opts.modelId || defaultEngineModel})`;
        }
        if (info.status === 'missing') {
          return `${fnName}: 当前账号未在云端配置可用的 AI 密钥，请先在偏好设置中配置 API Key`;
        }
      }
    } catch (err) {
      // 容错降级: 状态探测异常回退通用缺 Key 报错文案
      console.warn(`[ai] inspectUserModelKeyStatus failed in ${fnName}:`, err);
    }
  }
  return `${fnName}: 未检测到可用的用户 AI 密钥配置 (provider=${opts.providerKey}, model=${opts.modelId || defaultEngineModel})`;
}

export const modelName = DEFAULT_AI_MODEL;

// Factory function to get the correct model based on provider
interface DynamicModelOptions {
  provider?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
  apiFormat?: 'openai' | 'anthropic';
}

export function getDynamicModel(options: DynamicModelOptions) {
  const { provider, modelId = DEFAULT_AI_MODEL, apiKey: customKey, baseURL: customBaseUrl, apiFormat = 'openai' } = options;

  // Strict BYOK: API Key is required
  if (customKey && customKey.trim()) {
    let cleanBaseUrl = (customBaseUrl || '').trim().replace(/\/+$/, '');
    if (!cleanBaseUrl && provider && provider in AI_PROVIDER_PRESETS) {
      cleanBaseUrl = (AI_PROVIDER_PRESETS[provider]?.baseUrl || '').trim().replace(/\/+$/, '');
    }
    if (apiFormat === 'openai' || !apiFormat) {
      // 通用模型适配层(2026-09-20 转录 E2E 三重根因修复):
      // 1. 原生 undici fetch——Next 对 globalThis.fetch 的补丁会整段缓冲 SSE,
      //    provider 流式全部滞留至生成结束(网关看门狗必然误杀);
      // 2. 第三方兼容端点(自定义 baseURL)走 openai-compatible provider——
      //    原生透出思考型模型(qwen3/DeepSeek R1 等)的 reasoning_content 增量,
      //    openai provider 会把该字段静默丢弃,思考期整段不可见;
      // 3. 官方 OpenAI 端点(无 baseURL)保持 createOpenAI。
      const nativeFetchTyped = (async (...a: Parameters<typeof globalThis.fetch>) => {
        // undici 原生 fetch(绕开 Next 对 globalThis.fetch 的 SSE 缓冲补丁),
        // 再以运行时全局 Response 重包 body——桥接 undici Response 与宿主
        // 运行时(Next/turbopack)的流类型差异,SSE 增量得以逐事件透出
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

// Engine default configurations
export const defaultEngineProvider = (process.env.DEFAULT_ENGINE_PROVIDER as 'dashscope' | 'deepseek') || DEFAULT_AI_PROVIDER;
export const defaultEngineModel = process.env.DEFAULT_ENGINE_MODEL || DEFAULT_AI_MODEL;

// ─────────────────────────────────────────────────────────────
// 统一结构化输出入口（LLM Provider 适配层）
// 目标：调用方不感知底层模型差异，任一 provider 的 key 均可工作。
// 适配：@ai-sdk/openai 4.x 的 generateObject 只要传 zod schema 就固定发送
// response_format: json_schema（Structured Outputs）；DeepSeek API 不支持 json_schema，
// 仅支持 json_object（JSON mode，官方文档 https://api-docs.deepseek.com/guides/json_mode/）。
// 因此：先尝试 generateObject（qwen/openai 等支持 json_schema 的走严格模式）；
// 捕获 response_format/json_schema 类错误后，降级 generateText + prompt 强制 JSON +
// JSON 提取 + zod 校验（DeepSeek 路径，输出与严格模式一致）。
// 失败探测缓存：provider 首次确认不支持 json_schema 后，后续调用直接走 json_mode，
// 跳过必然失败的 generateObject 试错（进程内缓存，重启后重新探测一次）。
// ─────────────────────────────────────────────────────────────

/** 模型类型（generateObject / generateText 的 model 参数；测试可注入 fake 实现） */
type LanguageModelLike = Parameters<typeof generateObject>[0]['model'];

/** 已确认不支持 json_schema 的 provider（进程内缓存：跳过试错调用，降低真实 API 往返） */
const jsonSchemaUnsupportedProviders = new Set<string>();

export interface GenerateStructuredOptions<T> {
  schema: z.ZodType<T>;
  prompt: string;
  /** 覆盖默认引擎（缺省取 defaultEngineProvider）；string & {} 保留字面量提示同时允许自定义 key（测试注入） */
  provider?: 'deepseek' | 'dashscope' | (string & {});
  /** 覆盖默认模型（缺省取 defaultEngineModel） */
  modelId?: string;
  temperature?: number;
  /** 输出 token 上限透传（长输出模板如 mdx_enhance_localize 依赖 16000 防截断） */
  maxTokens?: number;
  /** 测试注入：替代真实模型（照 experience-validator 的 llm 注入先例，离线单测零 API 成本） */
  model?: LanguageModelLike;
  /** 预算熔断归属（Phase 2 #7）：BYOK 调用传 user 豁免；平台 key 传 userId 计量 */
  userId?: string | null;
  keyOrigin?: 'platform' | 'user';
  /** 记账 source（TokenUsageLog.source）：预算分桶配额按此通道隔离熔断 */
  source?: string;
  /** 关闭思考模式（非 thinking 模式直出：针对大纲等已有 AST 拓扑图的任务跳过漫长思考链） */
  disableThinking?: boolean;
  /** 显式开启深度思考模式（长链推理模式：针对测验等任务） */
  enableThinking?: boolean;
  /** 客户端断连级联：透传给 AI SDK 的 fetch，Abort 即取消上游 provider 生成 */
  abortSignal?: AbortSignal;
}

interface GenerateStructuredResult<T> {
  object: T;
  /** 兼容 trackTokenUsage（签名接受 any） */
  usage: unknown;
  /** 实际走的模式：'json_schema' = generateObject 严格模式；'json_mode' = DeepSeek JSON mode 降级 */
  mode: 'json_schema' | 'json_mode';
  /** SDK finishReason 原样透传（'length'=截断，调用方据此判失败） */
  finishReason?: unknown;
}

type ProviderOptionsLike = Parameters<typeof generateText>[0]['providerOptions'];

function resolveModelInfo(opts: { modelId?: string; provider?: string; model?: LanguageModelLike }): { modelId?: string; provider?: string } {
  const modelAny = opts.model as any;
  const modelId = opts.modelId || modelAny?.modelId || modelAny?.id || undefined;
  const provider = opts.provider || modelAny?.provider || undefined;
  return { modelId, provider };
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

/**
 * json_mode 降级实现：prompt 追加「只输出 JSON」指令（含 "JSON" 字样满足官方要求）+
 * zod schema 的 JSON 结构作为输出模板；提取首段 JSON 后按 schema 严格校验，
 * 校验失败将 ZodError issues 回传给模型要求修正重试（json_object 模式无服务端字段强制，
 * 模型可能缺字段/类型错，需反馈式重试兜底）。
 */
async function generateStructuredViaJsonMode<T>(
  opts: GenerateStructuredOptions<T>,
  model: LanguageModelLike
): Promise<GenerateStructuredResult<T>> {
  const { schema, prompt, provider, temperature } = opts;

  let schemaHint = '';
  try {
    const jsonSchema = (schema as { toJSON?: () => unknown }).toJSON?.();
    schemaHint = jsonSchema ? `\n\n输出 JSON 必须严格符合以下结构（字段齐全，类型一致）:\n${JSON.stringify(jsonSchema)}` : '';
  } catch {
    // 容错降级: schema 无 toJSON 时跳过结构提示（可选增强，缺失不影响输出契约）
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

    // 优先 0ms 纯确定性快速拆包与自愈 (Fast Path)
    const salvaged = fastSalvageJson(lastText, schema);
    if (salvaged !== null) {
      return { object: salvaged, usage: lastUsage, mode: 'json_mode', finishReason: lastFinishReason };
    }

    // 备用正则与 safeParse（向后兼容）
    const jsonMatch = lastText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
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

  // 慢路径智能微创急救 (Slow Path): 若常规重试均未能救活，调度低温微创修复
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
      // 容错降级: 慢路径修复失败，向下抛出真实错误
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
  /** 关闭思考模式（非 thinking 模式直出：跳过漫长思考链） */
  disableThinking?: boolean;
  /** 显式开启深度思考模式（长链推理模式） */
  enableThinking?: boolean;
  /** 客户端断连级联：透传给 AI SDK 的 fetch，Abort 即取消上游 provider 生成 */
  abortSignal?: AbortSignal;
}

interface GenerateCompletionTextResult {
  text: string;
  usage: unknown;
  finishReason: unknown;
}

/**
 * 自由文本补全入口（M2 网关 text purpose 用）：模型路由/预算门禁与
 * generateStructured 同语义，但不做 JSON/schema 强制——哨兵包裹的
 * markdown 输出（mdx_enhance_localize/mdx_repair 等）走本入口。
 * finishReason 原样透传（'length'=截断，调用方据此判失败）。
 */
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
      // 容错降级: 用户模型解析异常回退默认模型链路，留痕区分"未配置"与"解析异常"
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
  const result = await generateText({
    model,
    prompt: opts.prompt,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  return { text: result.text, usage: result.usage, finishReason: result.finishReason };
}

interface StreamCompletionTextResult {
  /** content 聚合流(思考类模型思考期零增量——网关用 fullStream,勿用本通道做活性判定) */
  textStream: AsyncIterable<string>;
  /** 全量 part 流:content(text-delta)与 reasoning(reasoning-delta)等通道全可见;
   * reasoning 载荷字段在 provider 实现间为 delta 或 text(见网关消费侧兼容注释) */
  fullStream: AsyncIterable<{ type: string; text?: string; delta?: string; id?: string }>;
  finishReason: Promise<unknown>;
  usage: Promise<unknown>;
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
      // 容错降级: 用户模型解析异常回退默认模型链路，留痕区分"未配置"与"解析异常"
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
  const result = streamText({
    model,
    prompt: opts.prompt,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
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
      // 容错降级: 用户模型解析异常回退默认模型链路，留痕区分"未配置"与"解析异常"
      console.warn('[ai] resolveActiveUserModel failed, falling back to default model:', err);
    }
  }

  if (!model) {
    throw new MissingApiKeyError(
      await buildMissingApiKeyMessage('generateStructured', { userId: opts.userId, providerKey, modelId })
    );
  }

  // 预算熔断门禁（Phase 2 #7）：BYOK 豁免
  const { checkLlmBudget } = await import('@/lib/llm-budget');
  await checkLlmBudget({ userId: opts.userId ?? null, keyOrigin: opts.keyOrigin ?? 'user', source: opts.source });

  // 失败探测缓存：该 provider 已确认不支持 json_schema → 直接降级 json_mode（跳过必然失败的试错调用）
  if (jsonSchemaUnsupportedProviders.has(providerKey)) {
    return generateStructuredViaJsonMode(opts, model);
  }

  try {
    const providerOptions = resolveProviderOptions(opts, model);
    const result = await generateObject({
      model,
      schema,
      prompt,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
    // refine 类校验（如「选项不得重复」）无法表达进 JSON Schema——generateObject 只保证
    // 基础形状。safeParse 兜底：违反 refine → 转 json_mode 反馈重试（带 Zod issues），
    // 而不是把 refine 失败原样上抛成调用侧 500（红队 TEST_GAP-1）。
    const checked = schema.safeParse(result.object);
    if (!checked.success) {
      return generateStructuredViaJsonMode(opts, model);
    }
    return { object: checked.data, usage: result.usage, mode: 'json_schema', finishReason: result.finishReason };
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    // 格式兼容类错误（json_schema 不受支持、模型未输出合规 JSON、思考模型参数冲突）触发降级；超时/限流等照常上抛由调用方处理
    if (!/response_format|json_schema|no object generated|could not parse|syntaxerror|始终思考|不支持关闭思考/i.test(msg)) throw err;

    jsonSchemaUnsupportedProviders.add(providerKey);
    return generateStructuredViaJsonMode(opts, model);
  }
}

export { trackTokenUsage } from '@/lib/analytics/token-usage';

