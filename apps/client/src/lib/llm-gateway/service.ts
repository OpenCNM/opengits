import { PromptRegistry } from '@/lib/prompt-registry';
import { z } from 'zod';
import {
  generateStructured,
  generateCompletionText,
  streamCompletionText,
  MissingApiKeyError,
  type GenerateStructuredOptions,
  type GenerateCompletionTextOptions,
} from '@/lib/ai';
import { BudgetExceededError } from '@/lib/llm-budget';
import {
  LLM_GATEWAY_PING_INTERVAL_MS,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
} from '@/lib/constants';
import { lookupLlmPurpose } from './registry';
import { normalizeStreamPart } from './stream-normalizer';
import { fastExtractJsonObject } from '@/lib/ai/salvage-structured';
import { ConcurrencyCoordinator, defaultCoordinator } from './concurrency-coordinator';
import {
  CircuitBreaker,
  defaultCircuitBreaker,
  buildBreakerKey,
  isRateLimitError,
} from './circuit-breaker';
import {
  type ModelCandidate,
  DEFAULT_TRANSCRIPTION_CASCADE,
  resolveUserModelCascade,
  inspectUserModelKeyStatus,
  toInjectableStructuredModel,
} from '@/lib/ai/user-model-resolver';

/**
 * ─────────────────────────────────────────────────────────────
 * LLM 网关服务层（M1 建立、M2 扩展 text 形态、方向 3 扩展 NDJSON 流式直通与心跳）：
 * purpose + variables + userId → structured: 校验 JSON / text: 哨兵原文 / stream: NDJSON 直通。
 *
 * 复用 generateStructured / generateCompletionText / streamCompletionText 全部语义
 * （模型路由/BYOK 解密/json_schema→json_mode 降级/预算熔断/token 记账），本层只做契约封装
 * 与错误分类。generateFn/completeFn/streamFn 注入缝供单测离线跑（零 API 成本）。
 * ─────────────────────────────────────────────────────────────
 */

export const llmGenerateRequestSchema = z.object({
  purpose: z.string().min(1).max(64),
  variables: z.record(z.string(), z.unknown()).default({}),
  /** BYOK 归属用户（模型解析与预算豁免判定；平台 key 调用点传 null） */
  userId: z.string().nullable().optional(),
});

type LlmGenerateRequest = z.infer<typeof llmGenerateRequestSchema>;

/** 结构化错误码契约（跨进程语义：调用方按 code 分支，不 parse 文案） */
export const LLM_GATEWAY_ERROR_CODES = {
  UNKNOWN_PURPOSE: 400,
  MISSING_API_KEY: 409,
  /** 密文存在但解密失败（环境密钥变更等）——与 MISSING_API_KEY 同为 409 永久性
   * 配置错误，但根因不同：重存 Key 才能恢复，绝不静默蹭平台级联伪装成功 */
  KEY_DECRYPT_FAILED: 409,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  GENERATION_FAILED: 502,
} as const;

type LlmGatewayErrorCode = keyof typeof LLM_GATEWAY_ERROR_CODES;

/** 用户 BYOK 密钥不可用（missing / decrypt_failed）的 Fail-closed 信号：
 *  携带网关契约错误码向上抛出，调用方按 code 分支（2026-11 收口：密钥类
 *  状态故障绝不静默回落平台级联——伪弹性会把 A 类基础设施故障伪装成成功）。 */
export class UserKeyUnavailableError extends Error {
  readonly code: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED';
  constructor(code: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED', message: string) {
    super(message);
    this.name = 'UserKeyUnavailableError';
    this.code = code;
  }
}

/**
 * 根据调用意图和用户身份解析可用候选模型降级链表。
 *
 * Fail-Closed 契约（2026-11 A 类故障收口）：
 * - userId 在场但用户级联为空 → 按密钥物理状态抛 UserKeyUnavailableError
 *   （decrypt_failed → KEY_DECRYPT_FAILED；missing → MISSING_API_KEY），
 *   绝不穿透到平台默认级联，绝不返回无密钥占位候选；
 * - userId 缺席 → 仅 keyOrigin='platform' 的 purpose 走平台级联；
 *   BYOK purpose 显式 fail-closed（树大纲等调用方契约本就要求 userId 必传）。
 */
export async function resolveCascadeCandidates(
  purpose: string,
  userId?: string | null
): Promise<ModelCandidate[]> {
  const purposeDef = lookupLlmPurpose(purpose);
  if (userId) {
    const userModels = await resolveUserModelCascade(userId);
    if (userModels.length > 0) {
      return userModels.map((m) => ({
        provider: m.provider,
        modelId: m.modelId,
        apiKey: m.apiKey,
        baseURL: m.baseURL,
        apiFormat: m.apiFormat,
        label: `${m.provider}/${m.modelId}`,
      }));
    }
    // 用户级联为空：精确报出密钥物理状态根因（先探测再报错，说真话）
    const keyStatus = await inspectUserModelKeyStatus(userId);
    if (keyStatus.status === 'decrypt_failed') {
      throw new UserKeyUnavailableError(
        'KEY_DECRYPT_FAILED',
        `云端已保存的 AI 密钥无法解密（可能因环境密钥变更失效），请重新填写并保存 API Key (provider=${keyStatus.provider || 'unknown'}, model=${keyStatus.modelId || DEFAULT_AI_MODEL})`
      );
    }
    throw new UserKeyUnavailableError(
      'MISSING_API_KEY',
      '当前账号未在云端配置可用的 AI 密钥，请先在偏好设置中配置 API Key'
    );
  }
  if (purposeDef?.keyOrigin === 'platform') {
    if (purposeDef.preferFastFallback) {
      const fastHead: ModelCandidate = {
        provider: DEFAULT_AI_PROVIDER,
        modelId: DEFAULT_AI_MODEL,
        label: `${DEFAULT_AI_PROVIDER}/${DEFAULT_AI_MODEL} (fast)`,
      };
      const rest = DEFAULT_TRANSCRIPTION_CASCADE.filter(
        (c) => !(c.provider === fastHead.provider && c.modelId === fastHead.modelId)
      );
      return [fastHead, ...rest];
    }
    return DEFAULT_TRANSCRIPTION_CASCADE;
  }
  throw new UserKeyUnavailableError(
    'MISSING_API_KEY',
    `purpose ${purpose} 为 BYOK 调用点（keyOrigin=user），必须携带 userId（当前缺失）——按契约 fail-closed，不回落平台级联`
  );
}

interface LlmGatewaySuccess {
  ok: true;
  /** structured：schema 校验后的 JSON object */
  object?: unknown;
  /** text：模型原文（哨兵包裹等后处理归调用方） */
  text?: string;
  /** structured：实际模式 */
  mode?: 'json_schema' | 'json_mode';
  /** finishReason 原样透传（'length'=截断，调用方据此判失败） */
  finishReason?: unknown;
  /** token 消耗遥测（可选透传） */
  usage?: unknown;
}

interface LlmGatewayFailure {
  ok: false;
  code: LlmGatewayErrorCode;
  message: string;
}

type LlmGatewayResult = LlmGatewaySuccess | LlmGatewayFailure;

type LlmGatewayStreamEvent =
  | { type: 'ping' }
  | { type: 'reset'; reason?: string }
  | { type: 'chunk'; delta: string; kind?: 'content' | 'reasoning' }
  | {
      type: 'done';
      ok: true;
      text?: string;
      object?: unknown;
      mode?: 'json_schema' | 'json_mode';
      finishReason?: unknown;
      usage?: unknown;
    }
  | {
      type: 'error';
      ok: false;
      code: LlmGatewayErrorCode;
      message: string;
    };

type GenerateFn = typeof generateStructured;
type CompleteFn = typeof generateCompletionText;
type StreamFn = (
  opts: GenerateCompletionTextOptions
) => Promise<{
  /** 全量 part 流(通用模型适配层):content 与 reasoning 等通道全部可见——
   *  textStream 聚合只含 content,思考类模型(qwen3 等)思考期的 reasoning
   *  增量会整段不可见,下游看门狗将思考误判为流静止(2026-09-20 转录 E2E) */
  fullStream: AsyncIterable<{ type?: string; [key: string]: unknown }> | AsyncIterable<unknown>;
  finishReason?: Promise<unknown> | unknown;
  usage?: Promise<unknown> | unknown;
}>;

export interface LlmGatewayDeps {
  generateFn?: GenerateFn;
  completeFn?: CompleteFn;
  streamFn?: StreamFn;
  pingIntervalMs?: number;
  callId?: string;
  signal?: AbortSignal;
  coordinator?: ConcurrencyCoordinator;
  circuitBreaker?: CircuitBreaker;
  cascadeCandidates?: ModelCandidate[];
}

/**
 * 从流式聚合文本中提取首个完整 JSON 对象（确定性花括号深度扫描，尊字符串
 * 转义——零 regex；供 structured 流式直出的终局 zod 闸门消费）。
 * 无完整对象时返回 undefined。
 */
function extractFirstJsonObject(text: string): unknown | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * 合并多阶段 Token 消耗，保证单账本入账 (Single-Ledger Conservation)
 */
export function mergeUsage(u1: unknown, u2: unknown): unknown {
  if (!u1) return u2;
  if (!u2) return u1;
  if (typeof u1 !== 'object' || typeof u2 !== 'object') return u2;
  const a = u1 as Record<string, unknown>;
  const b = u2 as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...a, ...b };
  for (const key of [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'tokens',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'reasoningTokens',
  ]) {
    const valA = typeof a[key] === 'number' ? (a[key] as number) : 0;
    const valB = typeof b[key] === 'number' ? (b[key] as number) : 0;
    if (typeof a[key] === 'number' || typeof b[key] === 'number') {
      merged[key] = valA + valB;
    }
  }
  return merged;
}

interface MetaCompilationResult {
  variables: Record<string, unknown>;
  phase1Usage?: unknown;
  fatalError?: LlmGatewayFailure;
  isCancelled?: boolean;
}

async function executeMetaCompilation(
  purpose: NonNullable<ReturnType<typeof lookupLlmPurpose>>,
  payload: LlmGenerateRequest,
  deps: LlmGatewayDeps,
): Promise<MetaCompilationResult> {
  const metaCompiler = purpose.metaCompiler;
  if (!metaCompiler) {
    return { variables: payload.variables };
  }

  if (metaCompiler.shouldCompile && !metaCompiler.shouldCompile(payload.variables)) {
    return { variables: payload.variables };
  }

  if (deps.signal?.aborted) {
    return { variables: payload.variables, isCancelled: true };
  }

  const timeoutMs = metaCompiler.timeoutMs ?? 8000;
  let phase1TimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const metaAbortController = new AbortController();

  const onParentAbort = () => {
    metaAbortController.abort(deps.signal?.reason);
  };

  if (deps.signal) {
    deps.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const metaVars = metaCompiler.prepareMetaVariables(payload.variables);

    const timeoutPromise = new Promise<never>((_, reject) => {
      phase1TimeoutTimer = setTimeout(() => {
        metaAbortController.abort();
        reject(new Error(`Meta-compiler timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const phase1Promise = runLlmGatewayGenerate(
      {
        purpose: metaCompiler.metaPurpose,
        variables: metaVars,
        userId: payload.userId,
      },
      {
        ...deps,
        signal: metaAbortController.signal,
      },
      { isInternal: true },
    );
    // Prevent unhandled promise rejection if timeout occurs before phase1 completes
    phase1Promise.catch(() => {});

    const phase1Result = await Promise.race([phase1Promise, timeoutPromise]);
    if (phase1TimeoutTimer) {
      clearTimeout(phase1TimeoutTimer);
      phase1TimeoutTimer = null;
    }

    if (deps.signal?.aborted) {
      return { variables: payload.variables, isCancelled: true };
    }

    if (phase1Result.ok) {
      const parsedBrief = metaCompiler.briefSchema.safeParse(phase1Result.object);
      if (parsedBrief.success) {
        return {
          variables: metaCompiler.injectBrief(parsedBrief.data, payload.variables),
          phase1Usage: phase1Result.usage,
        };
      }
      console.warn('[llm-gateway] Meta-compiler schema validation failed, falling back:', parsedBrief.error);
      return {
        variables: metaCompiler.injectBrief(null, payload.variables),
        phase1Usage: phase1Result.usage,
      };
    }

    // Fatal errors (auth, budget, rate-limit) must fail-closed rather than disguising as normal fallback
    // KEY_DECRYPT_FAILED 同列（2026-11 A 类收口）：密文损坏是永久配置错，
    // 伪降级会让主流程再烧一次 DB 探测才失败——违反 Frame-1 Fail-Fast
    if (
      phase1Result.code === 'MISSING_API_KEY' ||
      phase1Result.code === 'KEY_DECRYPT_FAILED' ||
      phase1Result.code === 'BUDGET_EXCEEDED' ||
      phase1Result.code === 'RATE_LIMITED'
    ) {
      return {
        variables: payload.variables,
        fatalError: phase1Result,
      };
    }

    console.warn('[llm-gateway] Meta-compiler phase 1 failed, falling back to brief=null:', phase1Result.message);
    return {
      variables: metaCompiler.injectBrief(null, payload.variables),
    };
  } catch (metaErr) {
    if (deps.signal?.aborted) {
      return { variables: payload.variables, isCancelled: true };
    }
    if (metaErr instanceof UserKeyUnavailableError) {
      return {
        variables: payload.variables,
        fatalError: { ok: false, code: metaErr.code, message: metaErr.message },
      };
    }
    if (metaErr instanceof MissingApiKeyError) {
      return {
        variables: payload.variables,
        fatalError: { ok: false, code: 'MISSING_API_KEY', message: metaErr.message },
      };
    }
    if (metaErr instanceof BudgetExceededError) {
      return {
        variables: payload.variables,
        fatalError: { ok: false, code: 'BUDGET_EXCEEDED', message: 'LLM budget exceeded — defer and retry later' },
      };
    }
    if (isRateLimitError(metaErr)) {
      const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
      return {
        variables: payload.variables,
        fatalError: { ok: false, code: 'RATE_LIMITED', message: msg.slice(0, 500) },
      };
    }
    console.warn('[llm-gateway] Meta-compiler exception/timeout, falling back to brief=null:', metaErr);
    return {
      variables: metaCompiler.injectBrief(null, payload.variables),
    };
  } finally {
    if (phase1TimeoutTimer) {
      clearTimeout(phase1TimeoutTimer);
      phase1TimeoutTimer = null;
    }
    if (deps.signal) {
      deps.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

export async function runLlmGatewayGenerate(
  payload: LlmGenerateRequest,
  deps: LlmGatewayDeps = {},
  options?: { isInternal?: boolean },
): Promise<LlmGatewayResult> {
  const purpose = lookupLlmPurpose(payload.purpose);
  if (!purpose) {
    return { ok: false, code: 'UNKNOWN_PURPOSE', message: `purpose not registered: ${payload.purpose}` };
  }

  const coordinator = deps.coordinator ?? defaultCoordinator;
  let release: (() => void) | null = null;
  // purpose 级 deadline 状态（try 内装配、finally 清理——声明提升到 try 外保证清理可达）
  let deadlineMs: number | undefined;
  let deadlineController: AbortController | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let onParentAbort: () => void = () => {};
  try {
    if (!options?.isInternal) {
      release = await coordinator.acquire(payload.userId, purpose.priority, { signal: deps.signal });
    }

    let effectiveVariables = payload.variables;
    let phase1Usage: unknown = undefined;

    if (purpose.metaCompiler && !options?.isInternal) {
      const metaRes = await executeMetaCompilation(purpose, payload, deps);
      if (metaRes.isCancelled || deps.signal?.aborted) {
        return { ok: false, code: 'GENERATION_FAILED', message: 'Request aborted' };
      }
      if (metaRes.fatalError) {
        return metaRes.fatalError;
      }
      effectiveVariables = metaRes.variables;
      phase1Usage = metaRes.phase1Usage;
    }

    const prompt = await purpose.compile(effectiveVariables);

    // purpose 级交互延迟预算（registry.timeoutMs 契约，网关单点强制）：到期
    // abort 级联进 AI SDK fetch——上游 provider 生成同步取消，不空烧 token。
    // 取代此前各 route 散装的 Promise.race「弃赛不掐线」补丁模式；与
    // deps.signal（客户端断连级联）取或门，任一触发即终止候选级联。
    deadlineMs = purpose.timeoutMs;
    deadlineController = deadlineMs ? new AbortController() : null;
    if (deadlineController) {
      onParentAbort = () => deadlineController?.abort(deps.signal?.reason);
      if (deps.signal) {
        if (deps.signal.aborted) {
          deadlineController.abort(deps.signal.reason);
        } else {
          deps.signal.addEventListener('abort', onParentAbort, { once: true });
        }
      }
      deadlineTimer = setTimeout(() => {
        deadlineController?.abort(new Error(`purpose deadline exceeded (${deadlineMs}ms)`));
      }, deadlineMs);
    }
    const deadlineExceeded = () =>
      Boolean(deadlineController?.signal.aborted) && !deps.signal?.aborted;
    const effectiveSignal = deadlineController?.signal ?? deps.signal;

    const common = {
      prompt,
      userId: payload.userId ?? undefined,
      keyOrigin: purpose.keyOrigin,
      source: purpose.source,
      ...(purpose.temperature !== undefined ? { temperature: purpose.temperature } : {}),
      ...(purpose.maxTokens !== undefined ? { maxTokens: purpose.maxTokens } : {}),
      ...(purpose.disableThinking !== undefined ? { disableThinking: purpose.disableThinking } : {}),
      ...(effectiveSignal ? { abortSignal: effectiveSignal } : {}),
    };

    const breaker = deps.circuitBreaker ?? defaultCircuitBreaker;
    let candidates = deps.cascadeCandidates;
    if (!candidates) {
      try {
        candidates = await resolveCascadeCandidates(payload.purpose, payload.userId);
      } catch (err) {
        // 密钥类状态故障：Fail-closed 透传真实根因码（绝不默认候选伪装可继续）
        if (err instanceof UserKeyUnavailableError) {
          return { ok: false, code: err.code, message: err.message };
        }
        // 基础设施异常（DB 不可达等）≠ 缺 Key：502 说真话，不吞成默认候选
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: 'GENERATION_FAILED',
          message: `model cascade resolution failed: ${reason}`.slice(0, 500),
        };
      }
    }
    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'MISSING_API_KEY',
        message: 'no model candidates resolved for this request',
      };
    }

    let lastError: unknown = null;
    let attempts = 0;
    let skippedByBreaker = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const breakerKey = buildBreakerKey(candidate.provider, candidate.modelId, payload.userId);

      // deadline 已耗尽：预算用完不再尝试备选（级联只在预算内发生）
      if (deadlineExceeded()) {
        return {
          ok: false,
          code: 'GENERATION_FAILED',
          message: `generation timed out after ${deadlineMs}ms (purpose deadline)`,
        };
      }

      if (!breaker.canExecute(breakerKey)) {
        skippedByBreaker++;
        console.warn(
          `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} circuit breaker is OPEN (fast-fail, 0 network overhead)`
        );
        continue;
      }

      attempts++;
      const injectableModel = candidate.apiKey ? toInjectableStructuredModel(candidate) : undefined;
      const commonWithCandidate = {
        ...common,
        provider: candidate.provider,
        modelId: candidate.modelId,
        ...(injectableModel ? { model: injectableModel } : {}),
      };

      try {
        if (purpose.kind === 'text') {
          const result = await (deps.completeFn ?? generateCompletionText)(
            commonWithCandidate as GenerateCompletionTextOptions
          );
          breaker.recordSuccess(breakerKey);
          if (result.usage && payload.userId) {
            const { TokenUsageService } = await import('@/lib/analytics/token-usage');
            void TokenUsageService.logSDKResult(payload.userId, result.usage, {
              source: purpose.source,
              keyOrigin: purpose.keyOrigin,
              // eval 捕获侧：registry-backed purpose 的编译 key 与 purpose id 一致，
              // 读编译时缓存版本（代码内建 purpose 无 DB 版本，自然为 null）
              purpose: payload.purpose,
              promptVersion: PromptRegistry.getCompiledVersion(payload.purpose),
            }).catch(() => {});
          }
          const combinedUsage = mergeUsage(phase1Usage, result.usage);
          return { ok: true, text: result.text, finishReason: result.finishReason, usage: combinedUsage };
        }

        const result = await (deps.generateFn ?? generateStructured)({
          ...commonWithCandidate,
          schema: purpose.schema as z.ZodType<unknown>,
        } as GenerateStructuredOptions<unknown>);
        breaker.recordSuccess(breakerKey);
        if (result.usage && payload.userId) {
          const { TokenUsageService } = await import('@/lib/analytics/token-usage');
          void TokenUsageService.logSDKResult(payload.userId, result.usage, {
            source: purpose.source,
            keyOrigin: purpose.keyOrigin,
            purpose: payload.purpose,
            promptVersion: PromptRegistry.getCompiledVersion(payload.purpose),
          }).catch(() => {});
        }
        const combinedUsage = mergeUsage(phase1Usage, result.usage);
        return {
          ok: true,
          object: result.object,
          mode: result.mode,
          finishReason: result.finishReason,
          usage: combinedUsage,
        };
      } catch (err) {
        lastError = err;

        // 1. MissingApiKeyError: 致命认证错误，立即 Fail-closed
        if (err instanceof MissingApiKeyError) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'MISSING_API_KEY', message: err.message };
        }
        // 2. BudgetExceededError: 预算熔断，立即 Fail-closed
        if (err instanceof BudgetExceededError) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'BUDGET_EXCEEDED', message: 'LLM budget exceeded — defer and retry later' };
        }
        // 3. 用户/客户端主动取消
        if (deps.signal?.aborted) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'GENERATION_FAILED', message: 'Request aborted' };
        }
        // 3.5 purpose 级 deadline 到期：非 provider 过错——不计入熔断，
        // 不再级联备选（预算已耗尽），fail-fast 上抛由调用方回落
        if (deadlineExceeded()) {
          breaker.releaseProbe(breakerKey);
          return {
            ok: false,
            code: 'GENERATION_FAILED',
            message: `generation timed out after ${deadlineMs}ms (purpose deadline)`,
          };
        }

        // 记录失败（区分 CLOSED 态智能过滤与 HALF_OPEN 态探针重试自愈）
        breaker.recordFailure(breakerKey, err);

        // 4. Rate limit 429: 不计入 CLOSED 态宕机熔断，若有备选则级联，否则返回 RATE_LIMITED
        if (isRateLimitError(err)) {
          if (i < candidates.length - 1) {
            const nextCandidate = candidates[i + 1];
            console.warn(
              `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} rate limited (429), cascading to backup ${nextCandidate.provider}/${nextCandidate.modelId}`
            );
            continue;
          }
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, code: 'RATE_LIMITED', message: message.slice(0, 500) };
        }

        // 5. 5xx / 网络层故障 / 超时：在有备选时级联
        if (i < candidates.length - 1) {
          const nextCandidate = candidates[i + 1];
          const statusOrMsg = (err as any)?.status || (err as any)?.statusCode || (err as Error)?.message || 'tripped';
          console.warn(
            `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} tripped (${statusOrMsg}), cascading to backup ${nextCandidate.provider}/${nextCandidate.modelId}`
          );
          continue;
        }
      }
    }

    if (skippedByBreaker > 0 && attempts === 0) {
      return {
        ok: false,
        code: 'GENERATION_FAILED',
        message: 'All candidate providers are currently circuit-broken (OPEN). Please retry later.',
      };
    }

    if (lastError) {
      if (isRateLimitError(lastError)) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        return { ok: false, code: 'RATE_LIMITED', message: message.slice(0, 500) };
      }
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      return { ok: false, code: 'GENERATION_FAILED', message: message.slice(0, 500) };
    }

    return {
      ok: false,
      code: 'GENERATION_FAILED',
      message: 'All candidate providers failed to generate',
    };
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    if (deadlineController && deps.signal) {
      deps.signal.removeEventListener('abort', onParentAbort);
    }
    if (release) {
      release();
    }
  }
}

/**
 * NDJSON 流式直通网关：生成器与 ReadableStream 契约，支持心跳保活与增量传输
 */
export function runLlmGatewayStream(
  payload: LlmGenerateRequest,
  deps: LlmGatewayDeps = {},
  options?: { isInternal?: boolean },
): ReadableStream<Uint8Array> {
  const pingIntervalMs = deps.pingIntervalMs ?? LLM_GATEWAY_PING_INTERVAL_MS;
  const encoder = new TextEncoder();
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const callId =
    deps.callId ||
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10));

  const traceEnv = process.env.LLM_STREAM_TRACE?.trim();
  const isTraceEnabled = Boolean(
    traceEnv &&
      (traceEnv === '*' ||
        traceEnv === '1' ||
        traceEnv === 'true' ||
        traceEnv.split(',').map((s) => s.trim()).includes(payload.purpose))
  );

  const partsHistogram = {
    text: 0,
    reasoning: 0,
    other: 0,
    unknown: 0,
  };

  const eventsHistogram = {
    chunk_content: 0,
    chunk_reasoning: 0,
    ping: 0,
  };

  const startTime = Date.now();
  let ttfbMs = -1;
  let firstContentMs = -1;
  let outcome: 'success' | 'error' | 'cancelled' = 'success';
  let summaryLogged = false;
  let isCancelled = false;

  let hasLoggedDroppedFrame = false;
  let hasLoggedUnknownPart = false;

  let release: (() => void) | null = null;
  const safeRelease = () => {
    if (release) {
      const fn = release;
      release = null;
      fn();
    }
  };

  const cleanup = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    safeRelease();
  };

  // 上游断连级联的最后一环：此前 signal 只停"转发"，provider HTTP 照常烧
  // token——本 controller 把取消传导进 AI SDK 的 fetch（abortSignal 透传）
  const upstreamAbort = new AbortController();

  const abortHandler = () => {
    isCancelled = true;
    outcome = 'cancelled';
    upstreamAbort.abort();
    cleanup();
  };

  if (deps.signal) {
    if (deps.signal.aborted) {
      abortHandler();
    } else {
      deps.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const emitSummary = () => {
    if (summaryLogged) return;
    summaryLogged = true;

    const totalMs = Date.now() - startTime;
    if (ttfbMs === -1) {
      ttfbMs = totalMs;
    }

    if (partsHistogram.reasoning > 0 && eventsHistogram.chunk_reasoning === 0) {
      console.error(
        `[llm-stream] STREAM_SHAPE_MISMATCH: reasoning parts received (${partsHistogram.reasoning}) but 0 chunk_reasoning events emitted! call=${callId}`
      );
    }

    console.log(
      `[llm-stream] call=${callId} purpose=${payload.purpose} outcome=${outcome} parts={text:${partsHistogram.text},reasoning:${partsHistogram.reasoning},other:${partsHistogram.other},unknown:${partsHistogram.unknown}} events={chunk_content:${eventsHistogram.chunk_content},chunk_reasoning:${eventsHistogram.chunk_reasoning},ping:${eventsHistogram.ping}} ttfb_ms=${ttfbMs} total_ms=${totalMs}`
    );
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (event: LlmGatewayStreamEvent) => {
        if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
          isCancelled = true;
          outcome = 'cancelled';
          cleanup();
          return;
        }
        if (ttfbMs === -1) {
          ttfbMs = Date.now() - startTime;
        }
        if (event.type === 'ping') {
          eventsHistogram.ping++;
        } else if (event.type === 'reset') {
          // 级联重置事件：用于清理消费方累积缓冲区，不计入正文 chunk 直方图
        } else if (event.type === 'chunk') {
          if (event.kind === 'reasoning') {
            eventsHistogram.chunk_reasoning++;
          } else {
            eventsHistogram.chunk_content++;
            if (firstContentMs === -1) {
              firstContentMs = Date.now() - startTime;
            }
          }
        }

        if (isTraceEnabled) {
          console.debug(
            `[llm-stream-trace] call=${callId} purpose=${payload.purpose} event=${event.type}${
              event.type === 'chunk'
                ? ` kind=${event.kind ?? 'content'} delta=${JSON.stringify(event.delta)}`
                : ''
            }`
          );
        }

        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          // controller closed / canceled by consumer
          isCancelled = true;
          outcome = 'cancelled';
          upstreamAbort.abort();
          cleanup();
        }
      };

      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          sendEvent({ type: 'ping' });
        }, pingIntervalMs);
      }

      // 流转发泵：provider 增量逐 part 归一化后转发（content/reasoning 双通道），
      // 返回聚合全文——text 直出与 structured 流式直出共用同一转发/观测语义
      const pumpStreamToEvents = async (
        streamResult: { fullStream: AsyncIterable<unknown> }
      ): Promise<string> => {
        let fullText = '';
        for await (const rawPart of streamResult.fullStream) {
          if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
            isCancelled = true;
            outcome = 'cancelled';
            upstreamAbort.abort();
            break;
          }
          const norm = normalizeStreamPart(rawPart);

          if (norm.kind === 'content') {
            partsHistogram.text++;
          } else if (norm.kind === 'reasoning') {
            partsHistogram.reasoning++;
          } else if (norm.kind === 'other') {
            partsHistogram.other++;
          } else {
            partsHistogram.unknown++;
          }

          // 遇到未知 part.type，第 1 帧打出 warning
          if (norm.kind === 'unknown' && !hasLoggedUnknownPart) {
            hasLoggedUnknownPart = true;
            console.warn(
              `[llm-stream] STREAM_UNKNOWN_PART: unknown part.type='${norm.rawType}' keys=${JSON.stringify(norm.keys ?? [])}`
            );
          }

          // 遇到思考型/内容增量但提取失败，第 1 帧立刻报错
          if ((norm.kind === 'content' || norm.kind === 'reasoning') && !norm.text && !hasLoggedDroppedFrame) {
            hasLoggedDroppedFrame = true;
            console.error(
              `[llm-stream] STREAM_SHAPE_DRIFT: ${norm.rawType || norm.kind} missing text payload on frame 1! actual_keys=${JSON.stringify(norm.keys ?? [])}`
            );
          }

          if (norm.kind === 'content' && norm.text) {
            fullText += norm.text;
            sendEvent({ type: 'chunk', kind: 'content', delta: norm.text });
          } else if (norm.kind === 'reasoning' && norm.text) {
            sendEvent({ type: 'chunk', kind: 'reasoning', delta: norm.text });
          }
        }
        return fullText;
      };

      try {
        if (isCancelled || deps.signal?.aborted) {
          outcome = 'cancelled';
          return;
        }
        const purpose = lookupLlmPurpose(payload.purpose);
        if (!purpose) {
          outcome = 'error';
          sendEvent({
            type: 'error',
            ok: false,
            code: 'UNKNOWN_PURPOSE',
            message: `purpose not registered: ${payload.purpose}`,
          });
          return;
        }

        if (!options?.isInternal) {
          const coordinator = deps.coordinator ?? defaultCoordinator;
          release = await coordinator.acquire(payload.userId, purpose.priority, { signal: deps.signal });
        }
        if (isCancelled || deps.signal?.aborted) {
          outcome = 'cancelled';
          safeRelease();
          return;
        }

        let effectiveVariables = payload.variables;
        let phase1Usage: unknown = undefined;

        if (purpose.metaCompiler && !options?.isInternal) {
          const metaRes = await executeMetaCompilation(purpose, payload, deps);
          if (metaRes.isCancelled || isCancelled || deps.signal?.aborted) {
            outcome = 'cancelled';
            safeRelease();
            return;
          }
          if (metaRes.fatalError) {
            outcome = 'error';
            sendEvent({
              type: 'error',
              ok: false,
              code: metaRes.fatalError.code,
              message: metaRes.fatalError.message,
            });
            return;
          }
          effectiveVariables = metaRes.variables;
          phase1Usage = metaRes.phase1Usage;
        }

        if (isCancelled || deps.signal?.aborted) {
          outcome = 'cancelled';
          safeRelease();
          return;
        }

        const prompt = await purpose.compile(effectiveVariables);
        const common = {
          prompt,
          userId: payload.userId ?? undefined,
          keyOrigin: purpose.keyOrigin,
          source: purpose.source,
          ...(purpose.temperature !== undefined ? { temperature: purpose.temperature } : {}),
          ...(purpose.maxTokens !== undefined ? { maxTokens: purpose.maxTokens } : {}),
          ...(purpose.disableThinking !== undefined ? { disableThinking: purpose.disableThinking } : {}),
        };

        const breaker = deps.circuitBreaker ?? defaultCircuitBreaker;
        let candidates = deps.cascadeCandidates;
        if (!candidates) {
          // 密钥类/基础设施类异常统一上抛，由外层 catch 按 code 分类
          // （Fail-closed：绝不吞成默认候选——与 generate 路径同一收口）
          candidates = await resolveCascadeCandidates(payload.purpose, payload.userId);
        }
        if (candidates.length === 0) {
          throw new UserKeyUnavailableError(
            'MISSING_API_KEY',
            'no model candidates resolved for this request'
          );
        }

        let streamSucceeded = false;
        let lastStreamError: unknown = null;
        let streamAttempts = 0;
        let streamSkippedByBreaker = 0;

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const breakerKey = buildBreakerKey(candidate.provider, candidate.modelId, payload.userId);

          if (!breaker.canExecute(breakerKey)) {
            streamSkippedByBreaker++;
            console.warn(
              `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} circuit breaker is OPEN (fast-fail, 0 network overhead)`
            );
            continue;
          }

          streamAttempts++;
          const injectableModel = candidate.apiKey ? toInjectableStructuredModel(candidate) : undefined;
          const candidateCommon = {
            ...common,
            provider: candidate.provider,
            modelId: candidate.modelId,
            ...(injectableModel ? { model: injectableModel } : {}),
            abortSignal: upstreamAbort.signal,
          };

          try {
            if (purpose.kind === 'text') {
              if (deps.completeFn) {
                const result = await deps.completeFn(candidateCommon as GenerateCompletionTextOptions);
                breaker.recordSuccess(breakerKey);
                partsHistogram.text++;
                sendEvent({ type: 'chunk', kind: 'content', delta: result.text });
                sendEvent({
                  type: 'done',
                  ok: true,
                  text: result.text,
                  finishReason: result.finishReason,
                  usage: mergeUsage(phase1Usage, result.usage),
                });
                streamSucceeded = true;
                break;
              } else {
                const runStream = deps.streamFn ?? streamCompletionText;
                const streamResult = await runStream(candidateCommon as GenerateCompletionTextOptions);
                const fullText = await pumpStreamToEvents(streamResult);
                if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
                  breaker.releaseProbe(breakerKey);
                  return;
                }
                const finishReason = await Promise.resolve(streamResult.finishReason ?? 'stop');
                const usage = await Promise.resolve(streamResult.usage);
                const combinedUsage = mergeUsage(phase1Usage, usage);
                sendEvent({
                  type: 'done',
                  ok: true,
                  text: fullText,
                  finishReason,
                  ...(combinedUsage ? { usage: combinedUsage } : {}),
                });
                breaker.recordSuccess(breakerKey);
                streamSucceeded = true;
                break;
              }
            } else if (deps.generateFn) {
              // Structured purpose（一元注入漏斗，测试/兼容路径）：非流式单 done
              partsHistogram.other++;
              const result = await deps.generateFn({
                ...candidateCommon,
                schema: purpose.schema as z.ZodType<unknown>,
              } as GenerateStructuredOptions<unknown>);
              breaker.recordSuccess(breakerKey);
              sendEvent({
                type: 'done',
                ok: true,
                object: result.object,
                mode: result.mode,
                finishReason: result.finishReason,
                usage: mergeUsage(phase1Usage, (result as { usage?: unknown }).usage),
              });
              streamSucceeded = true;
              break;
            } else {
              // Structured purpose 流式直出（outline 等交互路径）：provider 增量逐
              // chunk 透传——消费方（Go 侧）据此做活性判定与截止抢救；终局在网关
              // 侧收敛漏斗：JSON 提取 + zod 硬闸门通过后才发 done（与 Generate
              // 路径同一主权边界，LLM 零绕闸权限）。约束解码（response_format
              // json_schema）在流式通道不可用，结构合规由 prompt 内嵌格式指令 +
              // 终局 zod 闸门兜底（json_mode 同构）。校验失败走统一 throw：既有
              // catch 链记熔断、禁级联（chunk 已发出流已污染）、发 error 事件。
              const runStructuredStream = deps.streamFn ?? streamCompletionText;
              const streamResult = await runStructuredStream(candidateCommon as GenerateCompletionTextOptions);
              const fullText = await pumpStreamToEvents(streamResult);
              if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
                breaker.releaseProbe(breakerKey);
                return;
              }
              const finishReason = await Promise.resolve(streamResult.finishReason ?? 'stop');
              const usage = await Promise.resolve(streamResult.usage);
              let extracted = extractFirstJsonObject(fullText);
              if (extracted === undefined) {
                // 0ms 纯确定性状态机快速自愈：剥离 Markdown 围栏、<think> 外壳并自动补平因截断未闭合的括号
                extracted = fastExtractJsonObject(fullText);
              }
              if (extracted === undefined) {
                throw new Error(`streamed output contains no complete JSON object (len=${fullText.length})`);
              }

              // 确定性收敛漏斗（Deterministic Convergence Funnel）：
              // 在硬性 Zod 闸门校验前，调用 purpose.normalizeOutput 执行解包、字段别名对齐、长度裁剪与缺字段自愈，
              // 彻底将模型非确定性收敛在代码主权之下。
              const normalized = purpose.normalizeOutput ? purpose.normalizeOutput(extracted) : extracted;

              const checked = (purpose.schema as z.ZodType<unknown> | undefined)?.safeParse(normalized);
              if (!checked || !checked.success) {
                const issues = checked && !checked.success ? JSON.stringify(checked.error.issues) : 'purpose has no schema';
                throw new Error(`streamed output failed schema validation: ${issues.slice(0, 300)}`);
              }
              breaker.recordSuccess(breakerKey);
              // 记账走 streamCompletionText 内建 onFinish（单一账本：与 text
              // 分支同一机制，此处不重复入账）
              sendEvent({
                type: 'done',
                ok: true,
                text: JSON.stringify(checked.data),
                object: checked.data,
                finishReason,
                usage: mergeUsage(phase1Usage, usage),
              });
              streamSucceeded = true;
              break;
            }
          } catch (err) {
            lastStreamError = err;
            if (isCancelled || deps.signal?.aborted) {
              outcome = 'cancelled';
              breaker.releaseProbe(breakerKey);
              return;
            }

            // 致命配置错误直接外抛
            if (err instanceof MissingApiKeyError || err instanceof BudgetExceededError) {
              breaker.releaseProbe(breakerKey);
              throw err;
            }

            // 记录失败（区分 CLOSED 态智能过滤与 HALF_OPEN 态探针重试自愈）
            breaker.recordFailure(breakerKey, err);

            // 若有备选服务商，执行级联切换（发送 reset 清除下游累积的残缺流，并重置事件直方图）
            if (i < candidates.length - 1) {
              const nextCandidate = candidates[i + 1];
              if (eventsHistogram.chunk_content > 0 || eventsHistogram.chunk_reasoning > 0) {
                sendEvent({ type: 'reset', reason: 'cascade' });
                eventsHistogram.chunk_content = 0;
                eventsHistogram.chunk_reasoning = 0;
              }
              const statusOrMsg = (err as any)?.status || (err as any)?.statusCode || (err as Error)?.message || 'tripped';
              console.warn(
                `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} failed (${statusOrMsg}), cascading to backup ${nextCandidate.provider}/${nextCandidate.modelId}`
              );
              continue;
            }

            throw err;
          }
        }

        if (!streamSucceeded) {
          if (streamSkippedByBreaker > 0 && streamAttempts === 0) {
            outcome = 'error';
            sendEvent({
              type: 'error',
              ok: false,
              code: 'GENERATION_FAILED',
              message: 'All candidate providers are currently circuit-broken (OPEN). Please retry later.',
            });
            return;
          }
          if (lastStreamError) {
            throw lastStreamError;
          }
        }
      } catch (err) {
        if (isCancelled || deps.signal?.aborted) {
          outcome = 'cancelled';
        } else {
          outcome = 'error';
          if (err instanceof UserKeyUnavailableError) {
            sendEvent({ type: 'error', ok: false, code: err.code, message: err.message });
          } else if (err instanceof MissingApiKeyError) {
            sendEvent({ type: 'error', ok: false, code: 'MISSING_API_KEY', message: err.message });
          } else if (err instanceof BudgetExceededError) {
            sendEvent({
              type: 'error',
              ok: false,
              code: 'BUDGET_EXCEEDED',
              message: 'LLM budget exceeded — defer and retry later',
            });
          } else if (isRateLimitError(err)) {
            const message = err instanceof Error ? err.message : String(err);
            sendEvent({
              type: 'error',
              ok: false,
              code: 'RATE_LIMITED',
              message: message.slice(0, 500),
            });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            sendEvent({
              type: 'error',
              ok: false,
              code: 'GENERATION_FAILED',
              message: message.slice(0, 500),
            });
          }
        }
      } finally {
        if (deps.signal) {
          deps.signal.removeEventListener('abort', abortHandler);
        }
        cleanup();
        emitSummary();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      isCancelled = true;
      outcome = 'cancelled';
      cleanup();
      emitSummary();
    },
  });
}
