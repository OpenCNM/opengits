import { PromptRegistry } from '@/lib/prompt-registry';
import { ignoreBestEffort } from '@/lib/best-effort';
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
import { lookupLlmPurpose, type MetaBriefState } from './registry';
import * as m from '@/paraglide/messages';
import { normalizeStreamPart } from './stream-normalizer';
import { fastExtractJsonObject } from '@/lib/ai/salvage-structured';
import { ConcurrencyCoordinator, defaultCoordinator } from './concurrency-coordinator';
import {
  getEffectiveRuntimeConcurrency,
  type EffectiveRuntimeConcurrency,
} from '@/lib/gateway/policy';
import {
  CircuitBreaker,
  defaultCircuitBreaker,
  buildBreakerKey,
} from './circuit-breaker';
import {
  LLM_GATEWAY_ERROR_CODES,
  type LlmGatewayErrorCode,
  extractUpstreamError,
} from './upstream-error';
import {
  type ModelCandidate,
  DEFAULT_TRANSCRIPTION_CASCADE,
  resolveUserModelCascade,
  inspectUserModelKeyStatus,
  toInjectableStructuredModel,
} from '@/lib/ai/user-model-resolver';

export const llmGenerateRequestSchema = z.object({
  purpose: z.string().min(1).max(64),
  variables: z.record(z.string(), z.unknown()).default({}),
  userId: z.string().nullable().optional(),
});

type LlmGenerateRequest = z.infer<typeof llmGenerateRequestSchema>;

export { LLM_GATEWAY_ERROR_CODES };
export type { LlmGatewayErrorCode };

// Fail-closed on missing or undecryptable user BYOK keys; never fall back silently to platform models.
export class UserKeyUnavailableError extends Error {
  readonly code: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED';
  constructor(code: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED', message: string) {
    super(message);
    this.name = 'UserKeyUnavailableError';
    this.code = code;
  }
}

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
    const keyStatus = await inspectUserModelKeyStatus(userId);
    if (keyStatus.status === 'decrypt_failed') {
      throw new UserKeyUnavailableError(
        'KEY_DECRYPT_FAILED',
        `${m.toast_key_decrypt_failed()} (provider=${keyStatus.provider || 'unknown'}, model=${keyStatus.modelId || DEFAULT_AI_MODEL})`
      );
    }
    throw new UserKeyUnavailableError('MISSING_API_KEY', m.toast_missing_api_key());
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
  object?: unknown;
  text?: string;
  mode?: 'json_schema' | 'json_mode';
  finishReason?: unknown;
  usage?: unknown;
  briefState?: MetaBriefState;
}

interface LlmGatewayFailure {
  ok: false;
  code: LlmGatewayErrorCode;
  message: string;
  provider?: string;
  model?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
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
      briefState?: MetaBriefState;
    }
  | {
      type: 'error';
      ok: false;
      code: LlmGatewayErrorCode;
      message: string;
      provider?: string;
      model?: string;
      upstreamStatus?: number;
      upstreamCode?: string;
    };

type GenerateFn = typeof generateStructured;
type CompleteFn = typeof generateCompletionText;
type StreamFn = (
  opts: GenerateCompletionTextOptions
) => Promise<{
  // fullStream exposes reasoning deltas so watchdogs do not misclassify thinking phases as stalled.
  fullStream: AsyncIterable<{ type?: string; [key: string]: unknown }> | AsyncIterable<unknown>;
  finishReason?: Promise<unknown> | unknown;
  usage?: Promise<unknown> | unknown;
  getStreamError?: () => unknown;
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
  briefState?: MetaBriefState;
  fatalError?: LlmGatewayFailure;
  isCancelled?: boolean;
}

function logMetaBriefState(briefState: MetaBriefState | undefined, purpose: string, metaPurpose: string): void {
  if (!briefState) return;
  console.info(`[llm-gateway] Meta-compiler brief state=${briefState} purpose=${purpose} meta=${metaPurpose}`);
}

function toGatewayFailure(err: unknown, candidate?: ModelCandidate | null): LlmGatewayFailure {
  const info = extractUpstreamError(err, candidate ? { provider: candidate.provider, model: candidate.modelId } : undefined);
  return {
    ok: false,
    code: info.code,
    message: info.message,
    ...(info.provider ? { provider: info.provider } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.upstreamStatus !== undefined ? { upstreamStatus: info.upstreamStatus } : {}),
    ...(info.upstreamCode ? { upstreamCode: info.upstreamCode } : {}),
  };
}

function isPermanentUpstreamFailureCode(code: LlmGatewayErrorCode): boolean {
  return (
    code === 'MISSING_API_KEY' ||
    code === 'KEY_DECRYPT_FAILED' ||
    code === 'BUDGET_EXCEEDED' ||
    code === 'RATE_LIMITED' ||
    code === 'UPSTREAM_AUTH_ERROR' ||
    code === 'UPSTREAM_QUOTA_EXCEEDED' ||
    code === 'UPSTREAM_MODEL_NOT_FOUND'
  );
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
    // Prevent unhandled rejection if meta-compiler times out before completion.
    phase1Promise.catch(ignoreBestEffort);

    const phase1Result = await Promise.race([phase1Promise, timeoutPromise]);
    if (phase1TimeoutTimer) {
      clearTimeout(phase1TimeoutTimer);
      phase1TimeoutTimer = null;
    }

    if (deps.signal?.aborted) {
      return { variables: payload.variables, isCancelled: true };
    }

    if (phase1Result.ok) {
      const metaNormalize = lookupLlmPurpose(metaCompiler.metaPurpose)?.normalizeOutput;
      const normalizedObject = metaNormalize ? metaNormalize(phase1Result.object) : phase1Result.object;
      const parsedBrief = metaCompiler.briefSchema.safeParse(normalizedObject);
      if (parsedBrief.success) {
        const injected = metaCompiler.injectBrief(parsedBrief.data, payload.variables);
        return {
          variables: injected.variables,
          phase1Usage: phase1Result.usage,
          briefState: injected.briefState,
        };
      }
      console.warn('[llm-gateway] Meta-compiler schema validation failed, falling back:', parsedBrief.error);
      return {
        variables: metaCompiler.injectBrief(null, payload.variables).variables,
        phase1Usage: phase1Result.usage,
      };
    }

    if (isPermanentUpstreamFailureCode(phase1Result.code)) {
      return {
        variables: payload.variables,
        fatalError: phase1Result,
      };
    }

    console.warn('[llm-gateway] Meta-compiler phase 1 failed, falling back to brief=null:', phase1Result.message);
    return {
      variables: metaCompiler.injectBrief(null, payload.variables).variables,
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
    const metaInfo = extractUpstreamError(metaErr);
    if (isPermanentUpstreamFailureCode(metaInfo.code)) {
      return {
        variables: payload.variables,
        fatalError: toGatewayFailure(metaErr),
      };
    }
    console.warn('[llm-gateway] Meta-compiler exception/timeout, falling back to brief=null:', metaErr);
    return {
      variables: metaCompiler.injectBrief(null, payload.variables).variables,
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

export async function syncDefaultCoordinatorLimitsFromPolicy(): Promise<EffectiveRuntimeConcurrency> {
  const runtime = await getEffectiveRuntimeConcurrency();
  defaultCoordinator.applyLimits(
    runtime.effective.llmUserConcurrency,
    runtime.effective.llmInteractiveHeadroom,
  );
  return runtime;
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
  let deadlineMs: number | undefined;
  let deadlineController: AbortController | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let onParentAbort: () => void = () => {};
  try {
    if (!options?.isInternal) {
      if (!deps.coordinator && !deps.cascadeCandidates) {
        await syncDefaultCoordinatorLimitsFromPolicy();
      }
      release = await coordinator.acquire(payload.userId, purpose.priority, { signal: deps.signal });
    }

    let effectiveVariables = payload.variables;
    let phase1Usage: unknown = undefined;
    let briefState: MetaBriefState | undefined = undefined;

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
      briefState = metaRes.briefState;
      logMetaBriefState(briefState, payload.purpose, purpose.metaCompiler.metaPurpose);
    }

    const prompt = await purpose.compile(effectiveVariables);

    // Cascade purpose deadline and client AbortSignal into AI SDK fetch to cancel upstream token generation.
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
        if (err instanceof UserKeyUnavailableError) {
          return { ok: false, code: err.code, message: err.message };
        }
        // Return static message to clients and log raw error server-side so DB details never leak.
        console.error('[llm-gateway] model cascade resolution failed:', err);
        return {
          ok: false,
          code: 'GENERATION_FAILED',
          message: 'model cascade resolution failed (internal resolver error)',
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
    let lastCandidate: ModelCandidate | null = null;
    let attempts = 0;
    let skippedByBreaker = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const breakerKey = buildBreakerKey(candidate.provider, candidate.modelId, payload.userId);

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
              purpose: payload.purpose,
              promptVersion: PromptRegistry.getCompiledVersion(payload.purpose),
            }).catch(ignoreBestEffort);
          }
          const combinedUsage = mergeUsage(phase1Usage, result.usage);
          return {
            ok: true,
            text: result.text,
            finishReason: result.finishReason,
            usage: combinedUsage,
            ...(briefState ? { briefState } : {}),
          };
        }

        const result = await (deps.generateFn ?? generateStructured)({
          ...commonWithCandidate,
          schema: purpose.schema as z.ZodType<unknown>,
          ...(purpose.normalizeOutput ? { normalizeOutput: purpose.normalizeOutput } : {}),
        } as GenerateStructuredOptions<unknown>);
        breaker.recordSuccess(breakerKey);
        if (result.usage && payload.userId) {
          const { TokenUsageService } = await import('@/lib/analytics/token-usage');
          void TokenUsageService.logSDKResult(payload.userId, result.usage, {
            source: purpose.source,
            keyOrigin: purpose.keyOrigin,
            purpose: payload.purpose,
            promptVersion: PromptRegistry.getCompiledVersion(payload.purpose),
          }).catch(ignoreBestEffort);
        }
        const combinedUsage = mergeUsage(phase1Usage, result.usage);
        return {
          ok: true,
          object: result.object,
          mode: result.mode,
          finishReason: result.finishReason,
          usage: combinedUsage,
          ...(briefState ? { briefState } : {}),
        };
      } catch (err) {
        lastError = err;
        lastCandidate = candidate;

        if (err instanceof MissingApiKeyError) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'MISSING_API_KEY', message: err.message, provider: candidate.provider, model: candidate.modelId };
        }
        if (err instanceof BudgetExceededError) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'BUDGET_EXCEEDED', message: 'LLM budget exceeded — defer and retry later', provider: candidate.provider, model: candidate.modelId };
        }
        if (deps.signal?.aborted) {
          breaker.releaseProbe(breakerKey);
          return { ok: false, code: 'GENERATION_FAILED', message: 'Request aborted' };
        }
        // Purpose deadline expiry does not trip the circuit breaker and stops candidate fallback.
        if (deadlineExceeded()) {
          breaker.releaseProbe(breakerKey);
          return {
            ok: false,
            code: 'GENERATION_FAILED',
            message: `generation timed out after ${deadlineMs}ms (purpose deadline)`,
          };
        }

        breaker.recordFailure(breakerKey, err);

        const classified = toGatewayFailure(err, candidate);

        if (i < candidates.length - 1) {
          const nextCandidate = candidates[i + 1];
          const statusOrMsg = classified.upstreamStatus || classified.code || classified.message;
          console.warn(
            `[LLM-Gateway] Provider ${candidate.provider}/${candidate.modelId} failed (${statusOrMsg}), cascading to backup ${nextCandidate.provider}/${nextCandidate.modelId}`
          );
          continue;
        }
        return classified;
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
      return toGatewayFailure(lastError, lastCandidate);
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
      let lastStreamCandidate: ModelCandidate | null = null;
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

      // Surface AI SDK error/abort parts immediately instead of letting finishReason collapse to NoOutputGeneratedError.
      const pumpStreamToEvents = async (
        streamResult: { fullStream: AsyncIterable<unknown>; getStreamError?: () => unknown }
      ): Promise<string> => {
        let fullText = '';
        for await (const rawPart of streamResult.fullStream) {
          if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
            isCancelled = true;
            outcome = 'cancelled';
            upstreamAbort.abort();
            break;
          }
          if (rawPart && typeof rawPart === 'object' && !Array.isArray(rawPart)) {
            const rec = rawPart as Record<string, unknown>;
            if (rec.type === 'error') {
              const partErr = rec.error ?? streamResult.getStreamError?.();
              if (partErr instanceof Error) {
                throw partErr;
              }
              throw new Error(
                typeof partErr === 'string' && partErr
                  ? partErr
                  : JSON.stringify(partErr ?? 'Upstream stream error')
              );
            }
            if (rec.type === 'abort') {
              const reason = typeof rec.reason === 'string' && rec.reason ? rec.reason : 'Upstream stream aborted';
              throw new Error(reason);
            }
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

          if (norm.kind === 'unknown' && !hasLoggedUnknownPart) {
            hasLoggedUnknownPart = true;
            console.warn(
              `[llm-stream] STREAM_UNKNOWN_PART: unknown part.type='${norm.rawType}' keys=${JSON.stringify(norm.keys ?? [])}`
            );
          }

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
          if (!deps.coordinator && !deps.cascadeCandidates) {
            await syncDefaultCoordinatorLimitsFromPolicy();
          }
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
        let briefState: MetaBriefState | undefined = undefined;

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
              ...metaRes.fatalError,
            });
            return;
          }
          effectiveVariables = metaRes.variables;
          phase1Usage = metaRes.phase1Usage;
          briefState = metaRes.briefState;
          logMetaBriefState(briefState, payload.purpose, purpose.metaCompiler.metaPurpose);
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

        const resolveStreamMetadata = async (
          streamResult: { finishReason?: Promise<unknown> | unknown; usage?: Promise<unknown> | unknown; getStreamError?: () => unknown }
        ) => {
          try {
            const finishReason = await Promise.resolve(streamResult.finishReason ?? 'stop');
            const usage = await Promise.resolve(streamResult.usage);
            return { finishReason, usage };
          } catch (metaErr) {
            const captured = streamResult.getStreamError?.();
            throw captured ?? metaErr;
          }
        };

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
                  ...(briefState ? { briefState } : {}),
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
                const { finishReason, usage } = await resolveStreamMetadata(streamResult);
                const combinedUsage = mergeUsage(phase1Usage, usage);
                sendEvent({
                  type: 'done',
                  ok: true,
                  text: fullText,
                  finishReason,
                  ...(combinedUsage ? { usage: combinedUsage } : {}),
                  ...(briefState ? { briefState } : {}),
                });
                breaker.recordSuccess(breakerKey);
                streamSucceeded = true;
                break;
              }
            } else if (deps.generateFn) {
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
                ...(briefState ? { briefState } : {}),
              });
              streamSucceeded = true;
              break;
            } else {
              // Structured stream cannot use json_schema or cascade after chunks emit; final Zod gate enforces schema at stream end.
              const runStructuredStream = deps.streamFn ?? streamCompletionText;
              const streamResult = await runStructuredStream(candidateCommon as GenerateCompletionTextOptions);
              const fullText = await pumpStreamToEvents(streamResult);
              if (isCancelled || deps.signal?.aborted || outcome === 'cancelled') {
                breaker.releaseProbe(breakerKey);
                return;
              }
              const { finishReason, usage } = await resolveStreamMetadata(streamResult);
              let extracted = extractFirstJsonObject(fullText);
              if (extracted === undefined) {
                extracted = fastExtractJsonObject(fullText);
              }
              if (extracted === undefined) {
                throw new Error(`streamed output contains no complete JSON object (len=${fullText.length})`);
              }

              const normalized = purpose.normalizeOutput ? purpose.normalizeOutput(extracted) : extracted;

              const checked = (purpose.schema as z.ZodType<unknown> | undefined)?.safeParse(normalized);
              if (!checked || !checked.success) {
                const issues = checked && !checked.success ? JSON.stringify(checked.error.issues) : 'purpose has no schema';
                throw new Error(`streamed output failed schema validation: ${issues.slice(0, 300)}`);
              }
              breaker.recordSuccess(breakerKey);
              // Usage is recorded by streamCompletionText onFinish; skip duplicate ledger write here.
              sendEvent({
                type: 'done',
                ok: true,
                text: JSON.stringify(checked.data),
                object: checked.data,
                finishReason,
                usage: mergeUsage(phase1Usage, usage),
                ...(briefState ? { briefState } : {}),
              });
              streamSucceeded = true;
              break;
            }
          } catch (err) {
            lastStreamError = err;
            lastStreamCandidate = candidate;
            if (isCancelled || deps.signal?.aborted) {
              outcome = 'cancelled';
              breaker.releaseProbe(breakerKey);
              return;
            }

            if (err instanceof MissingApiKeyError || err instanceof BudgetExceededError) {
              breaker.releaseProbe(breakerKey);
              throw err;
            }

            breaker.recordFailure(breakerKey, err);

            if (i < candidates.length - 1) {
              const nextCandidate = candidates[i + 1];
              if (eventsHistogram.chunk_content > 0 || eventsHistogram.chunk_reasoning > 0) {
                sendEvent({ type: 'reset', reason: 'cascade' });
                eventsHistogram.chunk_content = 0;
                eventsHistogram.chunk_reasoning = 0;
              }
              const info = extractUpstreamError(err, { provider: candidate.provider, model: candidate.modelId });
              const statusOrMsg = info.upstreamStatus || info.code || info.message;
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
            sendEvent({
              type: 'error',
              ok: false,
              code: 'MISSING_API_KEY',
              message: err.message,
              ...(lastStreamCandidate ? { provider: lastStreamCandidate.provider, model: lastStreamCandidate.modelId } : {}),
            });
          } else if (err instanceof BudgetExceededError) {
            sendEvent({
              type: 'error',
              ok: false,
              code: 'BUDGET_EXCEEDED',
              message: 'LLM budget exceeded — defer and retry later',
              ...(lastStreamCandidate ? { provider: lastStreamCandidate.provider, model: lastStreamCandidate.modelId } : {}),
            });
          } else {
            const failure = toGatewayFailure(err, lastStreamCandidate);
            sendEvent({
              type: 'error',
              ...failure,
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
        } catch {
          ignoreBestEffort();
        }
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
