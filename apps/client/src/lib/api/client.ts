/**
 * 客户端统一 fetch 封装：与 defineRoute 的 { success, data / error, code?, detail? }
 * 信封契约配套。迁移期向后兼容——非信封 JSON（旧路由）原样返回，使路由可以
 * 按批次逐条迁移而不要求客户端一次性跟进。
 */
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;

  constructor(status: number, message: string, options?: { code?: string; detail?: string }) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = options?.code;
    this.detail = options?.detail;
  }
}

/** 统一信封（与服务端 api-error.ts 对齐） */
interface ApiFailureEnvelope {
  success: false;
  error: string;
  code?: string;
  detail?: string;
}

function isFailureEnvelope(json: unknown): json is ApiFailureEnvelope {
  return (
    typeof json === 'object' &&
    json !== null &&
    'success' in json &&
    'error' in json &&
    json.success === false &&
    typeof json.error === 'string'
  );
}

function isSuccessEnvelope(json: unknown): json is { success: true; data: unknown } {
  return (
    typeof json === 'object' &&
    json !== null &&
    'success' in json &&
    'data' in json &&
    json.success === true
  );
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** JSON 序列化后作为请求体，并自动附加 Content-Type */
  body?: unknown;
  /** 401 时的行为：默认 toast + 跳转登录页；'throw' 则仅抛 ApiClientError */
  onUnauthorized?: 'redirect' | 'throw';
  /** 失败时自动弹出错误 toast（默认 false，由调用方决定如何展示） */
  toastOnError?: boolean;
  /** 是否跳过 GET 请求在途合并（默认 false，合并相同 URL 的 pending 请求） */
  skipDedup?: boolean;
}

const inFlightGetRequests = new Map<string, Promise<any>>();

/** 401 统一登录引导（组件绕过 api 封装直接 fetch 时可复用） */
export function redirectToSignIn(): void {
  if (typeof window === 'undefined') return;
  // 已在登录页时不再重复跳转（防止 401 循环刷新）
  if (window.location.pathname.startsWith('/auth/')) return;
  toastManager.add({
    type: 'warning',
    title: m.toast_login_required(),
    description: m.toast_login_required_desc(),
  });
  window.location.assign('/auth/signin');
}

/**
 * 统一 API 请求：
 * - 成功信封 → 返回 data
 * - 失败信封 → 抛 ApiClientError（携带 status/code/detail）
 * - 非信封 JSON（迁移期旧路由）→ 原样返回
 * - 非 JSON 响应 → 按 HTTP status 生成错误
 * - 在途 GET 去重：相同 URL 的 GET 请求并发时自动合并复用同一 Promise
 */
export async function apiFetch<T>(input: string, options: ApiFetchOptions = {}): Promise<T> {
  const {
    body,
    onUnauthorized = 'redirect',
    toastOnError = false,
    skipDedup = false,
    headers,
    ...rest
  } = options;

  const method = (rest.method || 'GET').toUpperCase();
  const isGet = method === 'GET' && body === undefined;

  // In-Flight 并发请求合并：针对无 body 的 GET 请求，若已有相同请求在途则直接复用
  if (isGet && !skipDedup) {
    const existing = inFlightGetRequests.get(input);
    if (existing) {
      return existing as Promise<T>;
    }
  }

  const promise = (async () => {
    const init: RequestInit = {
      ...rest,
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      const error = new ApiClientError(0, err instanceof Error ? err.message : 'Network error', {
        code: 'NETWORK_ERROR',
      });
      if (toastOnError) {
        toastManager.add({ type: 'error', title: m.toast_action_failed(), description: error.message });
      }
      throw error;
    }

    // 401 统一登录引导（收敛此前各组件手写的三份同构逻辑）
    if (res.status === 401 && onUnauthorized === 'redirect') {
      redirectToSignIn();
      throw new ApiClientError(401, m.toast_login_required(), { code: 'UNAUTHORIZED' });
    }

    // 解析响应体：优先 JSON，容错非 JSON（如网关 HTML 错误页）
    let json: unknown = undefined;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      json = await res.json().catch(() => undefined);
    }

    if (isSuccessEnvelope(json)) {
      return json.data as T;
    }

    if (isFailureEnvelope(json)) {
      const error = new ApiClientError(res.status, json.error, { code: json.code, detail: json.detail });
      if (toastOnError) {
        toastManager.add({ type: 'error', title: m.toast_action_failed(), description: json.error });
      }
      throw error;
    }

    // 迁移期兼容：旧路由的非信封 JSON
    if (res.ok && json !== undefined) {
      return json as T;
    }

    // 迁移期兼容：网关或旧路由的非信封错误 JSON（如 { error: string } 或 { message: string }）
    if (typeof json === 'object' && json !== null) {
      const jsonObj = json as Record<string, unknown>;
      const rawError =
        typeof jsonObj.error === 'string'
          ? jsonObj.error
          : typeof jsonObj.message === 'string'
            ? jsonObj.message
            : null;
      if (rawError) {
        const rawCode =
          typeof jsonObj.code === 'string'
            ? jsonObj.code
            : res.status === 429
              ? 'RATE_LIMITED'
              : 'HTTP_ERROR';
        const rawDetail = typeof jsonObj.detail === 'string' ? jsonObj.detail : undefined;
        const error = new ApiClientError(res.status, rawError, { code: rawCode, detail: rawDetail });
        if (toastOnError) {
          toastManager.add({ type: 'error', title: m.toast_action_failed(), description: rawError });
        }
        throw error;
      }
    }

    const defaultMsg = res.status === 429 ? 'Too Many Requests' : `Request failed (${res.status})`;
    const defaultCode = res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
    const error = new ApiClientError(res.status, defaultMsg, { code: defaultCode });
    if (toastOnError) {
      toastManager.add({ type: 'error', title: m.toast_action_failed(), description: error.message });
    }
    throw error;
  })();

  if (isGet && !skipDedup) {
    inFlightGetRequests.set(input, promise);
    promise
      .finally(() => {
        inFlightGetRequests.delete(input);
      })
      .catch(() => {});
  }

  return promise;
}

/** 常用方法快捷封装（保留语义化调用点） */
export const api = {
  get: <T>(url: string, options?: ApiFetchOptions) => apiFetch<T>(url, { ...options, method: 'GET' }),
  post: <T>(url: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(url, { ...options, method: 'POST', body }),
  put: <T>(url: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(url, { ...options, method: 'PUT', body }),
  patch: <T>(url: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(url, { ...options, method: 'PATCH', body }),
  delete: <T>(url: string, options?: ApiFetchOptions) => apiFetch<T>(url, { ...options, method: 'DELETE' }),
};
