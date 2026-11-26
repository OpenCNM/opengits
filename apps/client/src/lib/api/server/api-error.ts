import * as m from '@/paraglide/messages';
import {
  extractUpstreamError,
  isUpstreamCallFailure,
  type UpstreamErrorContext,
  type UpstreamErrorMeta,
} from '@/lib/llm-gateway/upstream-error';

export const API_ERROR_CODES = {
  INVALID_PARAM: 'INVALID_PARAM',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  MISSING_API_KEY: 'MISSING_API_KEY',
  KEY_DECRYPT_FAILED: 'KEY_DECRYPT_FAILED',
  NO_MODEL: 'NO_MODEL',
  UPSTREAM_AUTH_ERROR: 'UPSTREAM_AUTH_ERROR',
  UPSTREAM_QUOTA_EXCEEDED: 'UPSTREAM_QUOTA_EXCEEDED',
  UPSTREAM_MODEL_NOT_FOUND: 'UPSTREAM_MODEL_NOT_FOUND',
  UPSTREAM_BAD_REQUEST: 'UPSTREAM_BAD_REQUEST',
  UPSTREAM_SERVER_ERROR: 'UPSTREAM_SERVER_ERROR',
  UPSTREAM_NETWORK_ERROR: 'UPSTREAM_NETWORK_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export const ERROR_CODE_STATUS_MAP: Record<ApiErrorCode, number> = {
  INVALID_PARAM: 400,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  MISSING_API_KEY: 400,
  KEY_DECRYPT_FAILED: 409,
  NO_MODEL: 409,
  UPSTREAM_AUTH_ERROR: 401,
  UPSTREAM_QUOTA_EXCEEDED: 402,
  UPSTREAM_MODEL_NOT_FOUND: 404,
  UPSTREAM_BAD_REQUEST: 400,
  UPSTREAM_SERVER_ERROR: 502,
  UPSTREAM_NETWORK_ERROR: 502,
};

export function getLocalizedErrorMessage(code: ApiErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return m.toast_login_required();
    case 'FORBIDDEN':
      return m.error_forbidden_title();
    case 'NOT_FOUND':
      return m.api_err_not_found();
    case 'INVALID_PARAM':
    case 'VALIDATION_ERROR':
      return m.api_err_invalid_param();
    case 'CONFLICT':
      return m.api_err_conflict();
    case 'RATE_LIMITED':
      return m.api_err_rate_limited();
    case 'SERVICE_UNAVAILABLE':
      return m.api_err_service_unavailable();
    case 'INTERNAL_ERROR':
      return m.api_err_internal();
    case 'MISSING_API_KEY':
      return m.toast_missing_api_key();
    case 'KEY_DECRYPT_FAILED':
      return m.toast_key_decrypt_failed();
    case 'NO_MODEL':
      return m.toast_missing_model_config();
    case 'UPSTREAM_AUTH_ERROR':
      return m.upstream_err_auth_title();
    case 'UPSTREAM_QUOTA_EXCEEDED':
      return m.upstream_err_quota_title();
    case 'UPSTREAM_MODEL_NOT_FOUND':
      return m.upstream_err_model_not_found_title();
    case 'UPSTREAM_BAD_REQUEST':
      return m.upstream_err_bad_request_title();
    case 'UPSTREAM_SERVER_ERROR':
      return m.upstream_err_server_title();
    case 'UPSTREAM_NETWORK_ERROR':
      return m.upstream_err_network_title();
    default:
      return m.api_err_internal();
  }
}

export interface ApiErrorOptions {
  code?: string;
  detail?: string;
  meta?: UpstreamErrorMeta;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly meta?: UpstreamErrorMeta;

  constructor(status: number, message: string, options?: ApiErrorOptions) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options?.code;
    this.detail = options?.detail;
    this.meta = options?.meta;
  }

  static fromCode(
    code: ApiErrorCode,
    options?: { detail?: string; message?: string; meta?: UpstreamErrorMeta }
  ) {
    const status = ERROR_CODE_STATUS_MAP[code] ?? 400;
    const message = options?.message ?? getLocalizedErrorMessage(code);
    return new ApiError(status, message, { code, detail: options?.detail, meta: options?.meta });
  }

  static badRequest(message?: string, options?: ApiErrorOptions) {
    return new ApiError(400, message ?? getLocalizedErrorMessage('INVALID_PARAM'), {
      code: options?.code ?? 'INVALID_PARAM',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static unauthorized(message?: string, options?: ApiErrorOptions) {
    return new ApiError(401, message ?? getLocalizedErrorMessage('UNAUTHORIZED'), {
      code: options?.code ?? 'UNAUTHORIZED',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static forbidden(message?: string, options?: ApiErrorOptions) {
    return new ApiError(403, message ?? getLocalizedErrorMessage('FORBIDDEN'), {
      code: options?.code ?? 'FORBIDDEN',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static notFound(message?: string, options?: ApiErrorOptions) {
    return new ApiError(404, message ?? getLocalizedErrorMessage('NOT_FOUND'), {
      code: options?.code ?? 'NOT_FOUND',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static conflict(message?: string, options?: ApiErrorOptions) {
    return new ApiError(409, message ?? getLocalizedErrorMessage('CONFLICT'), {
      code: options?.code ?? 'CONFLICT',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static tooManyRequests(message?: string, options?: ApiErrorOptions) {
    return new ApiError(429, message ?? getLocalizedErrorMessage('RATE_LIMITED'), {
      code: options?.code ?? 'RATE_LIMITED',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static serviceUnavailable(message?: string, options?: ApiErrorOptions) {
    return new ApiError(503, message ?? getLocalizedErrorMessage('SERVICE_UNAVAILABLE'), {
      code: options?.code ?? 'SERVICE_UNAVAILABLE',
      detail: options?.detail,
      meta: options?.meta,
    });
  }

  static internal(message?: string, options?: ApiErrorOptions) {
    return new ApiError(500, message ?? getLocalizedErrorMessage('INTERNAL_ERROR'), {
      code: options?.code ?? 'INTERNAL_ERROR',
      detail: options?.detail,
      meta: options?.meta,
    });
  }
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  detail?: string;
  meta?: UpstreamErrorMeta;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export function toApiErrorFromLlm(
  err: unknown,
  fallbackMessage: string,
  ctx?: UpstreamErrorContext
): ApiError {
  if (err instanceof ApiError) return err;
  const info = extractUpstreamError(err, ctx);
  const meta: UpstreamErrorMeta = {
    code: info.code,
    ...(info.provider ? { provider: info.provider } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.upstreamStatus !== undefined ? { upstreamStatus: info.upstreamStatus } : {}),
    ...(info.upstreamCode ? { upstreamCode: info.upstreamCode } : {}),
    ...(info.message ? { upstreamMessage: info.message } : {}),
  };
  if (info.code === 'BUDGET_EXCEEDED') {
    return ApiError.tooManyRequests(info.message, { code: 'RATE_LIMITED', detail: info.message, meta });
  }
  if (info.code === 'MISSING_API_KEY' || info.code === 'KEY_DECRYPT_FAILED') {
    return ApiError.fromCode(info.code, { detail: info.message, meta });
  }
  if (isUpstreamCallFailure(info)) {
    const code = info.code in API_ERROR_CODES ? (info.code as ApiErrorCode) : 'SERVICE_UNAVAILABLE';
    const prefix = info.provider && info.model ? `[${info.provider}/${info.model}] ` : '';
    const detail = `${prefix}${info.message}`;
    const baseTitle = getLocalizedErrorMessage(code);
    return new ApiError(info.status, `${baseTitle}: ${detail}`, {
      code,
      detail,
      meta,
    });
  }
  return ApiError.internal(fallbackMessage, {
    code: 'GENERATION_FAILED',
    detail: info.message,
    meta,
  });
}
