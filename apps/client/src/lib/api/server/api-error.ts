import * as m from '@/paraglide/messages';

/**
 * 全系统唯一的标准错误状态码枚举（闭合集合，严禁按路由定制散装错误码）。
 * 覆盖通用 HTTP 语义与平台级 BYOK 基础设施门禁。
 */
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
  /** 密文存在但解密失败（环境密钥变更）——与 MISSING_API_KEY 区分根因：
   *  重存 Key 才能恢复（2026-11 A 类收口：报真话不混淆） */
  KEY_DECRYPT_FAILED: 'KEY_DECRYPT_FAILED',
  NO_MODEL: 'NO_MODEL',
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
};

/**
 * 根据当前请求语言上下文，将标准错误码解析为精炼的多语言文案。
 */
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
    default:
      return m.api_err_internal();
  }
}

/**
 * 路由层统一错误类型：defineRoute 的 catch 通道据此生成标准错误响应。
 * 业务代码抛出 ApiError 即可携带 HTTP 语义（status/code）与可选 detail 旁路；
 * 非 ApiError 的未知异常由 defineRoute 兜底为 500（不向客户端泄漏内部错误消息）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;

  constructor(status: number, message: string, options?: { code?: string; detail?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options?.code;
    this.detail = options?.detail;
  }

  /**
   * 从标准系统错误码构建 ApiError，自动绑定对应 HTTP 状态码与多语言文案。
   */
  static fromCode(code: ApiErrorCode, options?: { detail?: string; message?: string }) {
    const status = ERROR_CODE_STATUS_MAP[code] ?? 400;
    const message = options?.message ?? getLocalizedErrorMessage(code);
    return new ApiError(status, message, { code, detail: options?.detail });
  }

  static badRequest(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(400, message ?? getLocalizedErrorMessage('INVALID_PARAM'), {
      code: options?.code ?? 'INVALID_PARAM',
      detail: options?.detail,
    });
  }

  static unauthorized(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(401, message ?? getLocalizedErrorMessage('UNAUTHORIZED'), {
      code: options?.code ?? 'UNAUTHORIZED',
      detail: options?.detail,
    });
  }

  static forbidden(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(403, message ?? getLocalizedErrorMessage('FORBIDDEN'), {
      code: options?.code ?? 'FORBIDDEN',
      detail: options?.detail,
    });
  }

  static notFound(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(404, message ?? getLocalizedErrorMessage('NOT_FOUND'), {
      code: options?.code ?? 'NOT_FOUND',
      detail: options?.detail,
    });
  }

  static conflict(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(409, message ?? getLocalizedErrorMessage('CONFLICT'), {
      code: options?.code ?? 'CONFLICT',
      detail: options?.detail,
    });
  }

  static tooManyRequests(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(429, message ?? getLocalizedErrorMessage('RATE_LIMITED'), {
      code: options?.code ?? 'RATE_LIMITED',
      detail: options?.detail,
    });
  }

  static serviceUnavailable(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(503, message ?? getLocalizedErrorMessage('SERVICE_UNAVAILABLE'), {
      code: options?.code ?? 'SERVICE_UNAVAILABLE',
      detail: options?.detail,
    });
  }

  static internal(message?: string, options?: { code?: string; detail?: string }) {
    return new ApiError(500, message ?? getLocalizedErrorMessage('INTERNAL_ERROR'), {
      code: options?.code ?? 'INTERNAL_ERROR',
      detail: options?.detail,
    });
  }
}

/** 统一成功响应体（defineRoute 自动包装） */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

/** 统一失败响应体（defineRoute 自动包装） */
export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  detail?: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;
