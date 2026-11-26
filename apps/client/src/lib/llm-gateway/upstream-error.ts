// Unwraps nested AI SDK errors (RetryError, NoOutputGeneratedError, stream error parts) into canonical gateway codes.

export const LLM_GATEWAY_ERROR_CODES = {
  UNKNOWN_PURPOSE: 400,
  MISSING_API_KEY: 409,
  // Distinguishes decryption failures from missing keys so callers prompt re-entry instead of masking the outage.
  KEY_DECRYPT_FAILED: 409,
  UPSTREAM_AUTH_ERROR: 401,
  UPSTREAM_QUOTA_EXCEEDED: 402,
  UPSTREAM_MODEL_NOT_FOUND: 404,
  UPSTREAM_BAD_REQUEST: 400,
  UPSTREAM_SERVER_ERROR: 502,
  UPSTREAM_NETWORK_ERROR: 502,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  GENERATION_FAILED: 502,
} as const;

export type LlmGatewayErrorCode = keyof typeof LLM_GATEWAY_ERROR_CODES;

export interface UpstreamErrorContext {
  provider?: string;
  model?: string;
}

export interface UpstreamErrorMeta {
  code?: string;
  provider?: string;
  model?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  upstreamMessage?: string;
}

export interface UpstreamErrorInfo {
  code: LlmGatewayErrorCode;
  status: number;
  message: string;
  rawMessage: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  provider?: string;
  model?: string;
  isRetryable: boolean;
}

interface UnwrappedFacts {
  statusCode?: number;
  responseBody?: string;
  data?: unknown;
  url?: string;
  errorCode?: string;
  errorName?: string;
  messages: string[];
  isUserKeyUnavailable?: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED';
  isMissingApiKey?: boolean;
  isBudgetExceeded?: boolean;
}

const MAX_UNWRAP_DEPTH = 8;

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const GENERIC_WRAPPER_MESSAGE_RE =
  /^(no output generated\.?|failed after \d+ attempts\.?.*|an error occurred\.?|fetch failed|stream error|tree outline failed:?.*)$/i;

function safeString(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return String(val);
  }
  return undefined;
}

function parseJsonBody(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
      }
    }
  }
  return null;
}

function extractBodyFields(bodyObj: Record<string, unknown> | null): {
  bodyMessage?: string;
  bodyCode?: string;
} {
  if (!bodyObj) return {};

  const nestedError =
    bodyObj.error && typeof bodyObj.error === 'object' && !Array.isArray(bodyObj.error)
      ? (bodyObj.error as Record<string, unknown>)
      : null;

  const bodyCode =
    safeString(nestedError?.code) ??
    safeString(nestedError?.type) ??
    safeString(bodyObj.code) ??
    safeString(bodyObj.error_code) ??
    safeString(bodyObj.type);

  const bodyMessage =
    safeString(nestedError?.message) ??
    safeString(nestedError?.msg) ??
    safeString(bodyObj.message) ??
    safeString(bodyObj.msg) ??
    safeString(bodyObj.detail) ??
    safeString(bodyObj.error_msg) ??
    (typeof bodyObj.error === 'string' ? safeString(bodyObj.error) : undefined);

  return { bodyMessage, bodyCode };
}

function collectFacts(err: unknown): UnwrappedFacts {
  const facts: UnwrappedFacts = { messages: [] };
  const visited = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH && current != null; depth++) {
    if (typeof current === 'string') {
      const s = safeString(current);
      if (s) facts.messages.push(s);
      break;
    }
    if (typeof current !== 'object' || visited.has(current)) {
      break;
    }
    visited.add(current);

    const rec = current as Record<string, unknown>;
    const name = safeString(rec.name);
    if (!facts.errorName && name) facts.errorName = name;

    if (name === 'UserKeyUnavailableError' && (rec.code === 'MISSING_API_KEY' || rec.code === 'KEY_DECRYPT_FAILED')) {
      facts.isUserKeyUnavailable = rec.code;
    }
    if (name === 'MissingApiKeyError') {
      facts.isMissingApiKey = true;
    }
    if (name === 'BudgetExceededError') {
      facts.isBudgetExceeded = true;
    }

    const msg = safeString(rec.message);
    if (msg) facts.messages.push(msg);

    const status =
      typeof rec.statusCode === 'number' && rec.statusCode > 0
        ? rec.statusCode
        : typeof rec.status === 'number' && rec.status > 0
          ? rec.status
          : undefined;
    if (status !== undefined) facts.statusCode = status;

    const code = safeString(rec.code);
    if (code) facts.errorCode = code;

    const url = safeString(rec.url);
    if (url) facts.url = url;

    const responseBody = safeString(rec.responseBody);
    if (responseBody) facts.responseBody = responseBody;

    if (rec.data !== undefined && rec.data !== null) {
      facts.data = rec.data;
    }

    if (rec.lastError !== undefined && rec.lastError !== null && !visited.has(rec.lastError)) {
      current = rec.lastError;
      continue;
    }
    if (Array.isArray(rec.errors) && rec.errors.length > 0) {
      const tail = rec.errors[rec.errors.length - 1];
      if (tail !== undefined && tail !== null && !visited.has(tail)) {
        current = tail;
        continue;
      }
    }
    if (rec.cause !== undefined && rec.cause !== null && !visited.has(rec.cause)) {
      current = rec.cause;
      continue;
    }
    if (rec.error !== undefined && rec.error !== null && !visited.has(rec.error)) {
      current = rec.error;
      continue;
    }
    break;
  }

  return facts;
}

function pickCleanMessage(
  bodyMessage: string | undefined,
  responseBody: string | undefined,
  messages: string[]
): string {
  if (bodyMessage) return bodyMessage;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!GENERIC_WRAPPER_MESSAGE_RE.test(m)) {
      return m;
    }
  }

  if (responseBody && !/^\s*<!doctype|^\s*<html/i.test(responseBody)) {
    return responseBody.slice(0, 400);
  }

  return messages[messages.length - 1] || messages[0] || 'Unknown upstream error';
}

function isQuotaOrBalanceSignal(combined: string, upstreamCode?: string): boolean {
  if (upstreamCode && /^(1113|1308|1309|insufficient_quota|quota_exceeded|arrearage|billing_hard_limit_reached)$/i.test(upstreamCode)) {
    return true;
  }
  return /insufficient[_\s-]?quota|insufficient[_\s-]?balance|arrearage|quota[_\s-]?exceeded|billing[_\s-]?hard[_\s-]?limit|exceeded your current quota|out of credits?|credit balance is too low|usage limit|使用上限|额度不足|额度已用尽|额度耗尽|余额不足|欠费|超额按量|资源包已耗尽|套餐已过期/i.test(
    combined
  );
}

function isAuthSignal(combined: string, upstreamCode?: string): boolean {
  if (upstreamCode && /^(invalid_api_key|authentication_error|unauthorized|permission_denied|access_denied)$/i.test(upstreamCode)) {
    return true;
  }
  return /invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication[_\s-]?error|invalid x-api-key|api key not valid|token expired|unauthorized|密钥无效|无效的\s*api\s*key/i.test(
    combined
  );
}

function isModelNotFoundSignal(combined: string, upstreamCode?: string): boolean {
  if (upstreamCode && /^(model_not_found|no_such_model|model_not_available)$/i.test(upstreamCode)) {
    return true;
  }
  return /model[_\s-]?not[_\s-]?found|model\s+['"`]?[\w.:/-]+['"`]?\s+does not exist|not a valid model|unknown model|模型不存在|未找到模型/i.test(
    combined
  );
}

function isRateLimitSignal(combined: string, upstreamCode?: string): boolean {
  if (upstreamCode && /^(rate_limit_exceeded|too_many_requests|throttling|1302|1303|1305)$/i.test(upstreamCode)) {
    return true;
  }
  return /rate\s*limit|ratelimit|throttling|too\s*many\s*requests|toomanyrequests|requests?\s*per\s*(min|sec|day)|rpm|tpm|速率限制|请求频率|并发超限|并发数超过限制|触发.*限流/i.test(
    combined
  );
}

function isBadRequestSignal(combined: string, upstreamCode?: string): boolean {
  if (
    upstreamCode &&
    /^(context_length_exceeded|string_above_max_length|content_filter|data_inspection_failed|invalid_request_error)$/i.test(
      upstreamCode
    )
  ) {
    return true;
  }
  return /context[_\s-]?length[_\s-]?exceeded|maximum context length|too many tokens|content[_\s-]?filter|data_inspection_failed|inappropriate content|上下文长度|输入过长|敏感内容|安全审核/i.test(
    combined
  );
}

function isNetworkSignal(combined: string, errorCode?: string): boolean {
  if (errorCode && NETWORK_ERROR_CODES.has(errorCode.toUpperCase())) {
    return true;
  }
  return /econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|und_err|socket\s*hang\s*up|socket\s*reset|reset\s*by\s*peer|connection\s*reset|fetch\s*failed|network\s*error|timed\s*out|timeout|certificate|self-signed/i.test(
    combined
  );
}

function isServerSignal(combined: string): boolean {
  return /service\s*unavailable|bad\s*gateway|gateway\s*time-?out|internal\s*server\s*error|overloaded|server\s*is\s*busy|服务暂不可用|系统繁忙/i.test(
    combined
  );
}

export function extractUpstreamError(
  err: unknown,
  ctx?: UpstreamErrorContext
): UpstreamErrorInfo {
  const facts = collectFacts(err);

  if (facts.isUserKeyUnavailable) {
    const msg = facts.messages[facts.messages.length - 1] || 'API Key unavailable';
    return {
      code: facts.isUserKeyUnavailable,
      status: 409,
      message: msg.slice(0, 500),
      rawMessage: msg,
      ...(ctx?.provider ? { provider: ctx.provider } : {}),
      ...(ctx?.model ? { model: ctx.model } : {}),
      isRetryable: false,
    };
  }

  if (facts.isMissingApiKey) {
    const msg = facts.messages[facts.messages.length - 1] || 'Missing API Key';
    return {
      code: 'MISSING_API_KEY',
      status: 409,
      message: msg.slice(0, 500),
      rawMessage: msg,
      ...(ctx?.provider ? { provider: ctx.provider } : {}),
      ...(ctx?.model ? { model: ctx.model } : {}),
      isRetryable: false,
    };
  }

  if (facts.isBudgetExceeded) {
    return {
      code: 'BUDGET_EXCEEDED',
      status: 429,
      message: 'LLM budget exceeded — defer and retry later',
      rawMessage: facts.messages.join(' | ') || 'BudgetExceededError',
      ...(ctx?.provider ? { provider: ctx.provider } : {}),
      ...(ctx?.model ? { model: ctx.model } : {}),
      isRetryable: true,
    };
  }

  const parsedData = parseJsonBody(facts.data) ?? parseJsonBody(facts.responseBody);
  const { bodyMessage, bodyCode } = extractBodyFields(parsedData);

  const upstreamCode = bodyCode ?? facts.errorCode;
  const upstreamStatus = facts.statusCode;
  const cleanMessage = pickCleanMessage(bodyMessage, facts.responseBody, facts.messages);
  const rawMessage = facts.messages.join(' | ') || cleanMessage;
  const combined = `${cleanMessage} ${rawMessage} ${facts.responseBody ?? ''}`;

  let code: LlmGatewayErrorCode = 'GENERATION_FAILED';
  let isRetryable = false;

  if (upstreamStatus === 402 || isQuotaOrBalanceSignal(combined, upstreamCode)) {
    code = 'UPSTREAM_QUOTA_EXCEEDED';
    isRetryable = false;
  } else if (upstreamStatus === 401 || upstreamStatus === 403 || isAuthSignal(combined, upstreamCode)) {
    code = 'UPSTREAM_AUTH_ERROR';
    isRetryable = false;
  } else if (upstreamStatus === 404 || isModelNotFoundSignal(combined, upstreamCode)) {
    code = 'UPSTREAM_MODEL_NOT_FOUND';
    isRetryable = false;
  } else if (upstreamStatus === 429 || isRateLimitSignal(combined, upstreamCode)) {
    code = 'RATE_LIMITED';
    isRetryable = true;
  } else if (upstreamStatus === 400 || upstreamStatus === 422 || isBadRequestSignal(combined, upstreamCode)) {
    code = 'UPSTREAM_BAD_REQUEST';
    isRetryable = false;
  } else if (typeof upstreamStatus === 'number' && upstreamStatus >= 500 && upstreamStatus < 600) {
    code = 'UPSTREAM_SERVER_ERROR';
    isRetryable = true;
  } else if (upstreamStatus === undefined && isNetworkSignal(combined, facts.errorCode)) {
    code = 'UPSTREAM_NETWORK_ERROR';
    isRetryable = true;
  } else if (isServerSignal(combined)) {
    code = 'UPSTREAM_SERVER_ERROR';
    isRetryable = true;
  } else if (isNetworkSignal(combined, facts.errorCode)) {
    code = 'UPSTREAM_NETWORK_ERROR';
    isRetryable = true;
  }

  const status = upstreamStatus ?? LLM_GATEWAY_ERROR_CODES[code];

  return {
    code,
    status,
    message: cleanMessage.slice(0, 500),
    rawMessage: rawMessage.slice(0, 1000),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(ctx?.provider ? { provider: ctx.provider } : {}),
    ...(ctx?.model ? { model: ctx.model } : {}),
    isRetryable,
  };
}

export function isUpstreamCallFailure(info: UpstreamErrorInfo): boolean {
  return info.code !== 'GENERATION_FAILED' || info.upstreamStatus !== undefined;
}

const STREAM_ERR_PREFIX = '__OG_LLM_ERR__:';

export function serializeClientStreamError(
  err: unknown,
  ctx?: UpstreamErrorContext
): string {
  const info = extractUpstreamError(err, ctx);
  return `${STREAM_ERR_PREFIX}${JSON.stringify({
    code: info.code,
    message: info.message,
    status: info.status,
    upstreamStatus: info.upstreamStatus,
    upstreamCode: info.upstreamCode,
    provider: info.provider,
    model: info.model,
  })}`;
}

export interface ParsedClientStreamError {
  code?: string;
  message: string;
  status?: number;
  upstreamStatus?: number;
  upstreamCode?: string;
  provider?: string;
  model?: string;
}

export function parseClientStreamError(rawMessage: string | undefined | null): ParsedClientStreamError {
  const text = String(rawMessage || '').trim();
  if (text.startsWith(STREAM_ERR_PREFIX)) {
    try {
      const parsed = JSON.parse(text.slice(STREAM_ERR_PREFIX.length)) as Partial<ParsedClientStreamError>;
      if (parsed && typeof parsed.message === 'string') {
        return {
          code: parsed.code,
          message: parsed.message,
          status: parsed.status,
          upstreamStatus: parsed.upstreamStatus,
          upstreamCode: parsed.upstreamCode,
          provider: parsed.provider,
          model: parsed.model,
        };
      }
    } catch {
    }
  }
  return { message: text };
}

const STRUCTURED_DB_ERR_PREFIX = '__OG_ERR__:';
const MAX_STRUCTURED_DB_ERR_LEN = 500;

function buildStructuredDbPayload(
  meta: UpstreamErrorMeta,
  message?: string,
  includeOptionalFields = true
): Record<string, unknown> {
  return {
    ...(meta.code ? { code: meta.code } : {}),
    ...(includeOptionalFields && meta.provider ? { provider: meta.provider } : {}),
    ...(includeOptionalFields && meta.model ? { model: meta.model } : {}),
    ...(includeOptionalFields && meta.upstreamStatus !== undefined
      ? { upstreamStatus: meta.upstreamStatus }
      : {}),
    ...(includeOptionalFields && meta.upstreamCode ? { upstreamCode: meta.upstreamCode } : {}),
    ...(message ? { message } : {}),
  };
}

// Binary-search truncation before JSON.stringify guarantees __OG_ERR__: payloads stay valid JSON within DB column limits.
export function encodeStructuredDbError(
  meta: UpstreamErrorMeta,
  maxLen = MAX_STRUCTURED_DB_ERR_LEN
): string {
  const rawMsg = safeString(meta.upstreamMessage);
  const full = `${STRUCTURED_DB_ERR_PREFIX}${JSON.stringify(buildStructuredDbPayload(meta, rawMsg))}`;
  if (full.length <= maxLen) {
    return full;
  }

  if (rawMsg) {
    let lo = 0;
    let hi = rawMsg.length;
    let best = `${STRUCTURED_DB_ERR_PREFIX}${JSON.stringify(buildStructuredDbPayload(meta, undefined))}`;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidateMsg = mid === 0 ? undefined : mid < rawMsg.length ? `${rawMsg.slice(0, mid)}...` : rawMsg;
      const candidate = `${STRUCTURED_DB_ERR_PREFIX}${JSON.stringify(
        buildStructuredDbPayload(meta, candidateMsg)
      )}`;
      if (candidate.length <= maxLen) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best.length <= maxLen) {
      return best;
    }
  }

  const minimal = `${STRUCTURED_DB_ERR_PREFIX}${JSON.stringify(buildStructuredDbPayload(meta, undefined, false))}`;
  if (minimal.length <= maxLen) {
    return minimal;
  }
  return `${STRUCTURED_DB_ERR_PREFIX}{}`;
}

export function decodeStructuredDbError(raw: string | null | undefined): UpstreamErrorMeta | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(STRUCTURED_DB_ERR_PREFIX);
  if (idx === -1) return null;

  const jsonPart = trimmed.slice(idx + STRUCTURED_DB_ERR_PREFIX.length).trim();
  if (!jsonPart.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const meta: UpstreamErrorMeta = {
      ...(safeString(parsed.code) ? { code: safeString(parsed.code) } : {}),
      ...(safeString(parsed.provider) ? { provider: safeString(parsed.provider) } : {}),
      ...(safeString(parsed.model) ? { model: safeString(parsed.model) } : {}),
      ...(typeof parsed.upstreamStatus === 'number' && Number.isFinite(parsed.upstreamStatus)
        ? { upstreamStatus: parsed.upstreamStatus }
        : {}),
      ...(safeString(parsed.upstreamCode) ? { upstreamCode: safeString(parsed.upstreamCode) } : {}),
      ...(safeString(parsed.upstreamMessage) ?? safeString(parsed.message)
        ? { upstreamMessage: safeString(parsed.upstreamMessage) ?? safeString(parsed.message) }
        : {}),
    };
    return Object.keys(meta).length > 0 ? meta : null;
  } catch {
    return null;
  }
}
