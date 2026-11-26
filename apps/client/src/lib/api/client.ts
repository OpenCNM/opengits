import { toastManager } from '@/components/ui/toast';
import { ignoreBestEffort } from '@/lib/best-effort';
import type { UpstreamErrorMeta } from '@/lib/llm-gateway/upstream-error';
import * as m from '@/paraglide/messages';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly meta?: UpstreamErrorMeta;

  constructor(
    status: number,
    message: string,
    options?: { code?: string; detail?: string; meta?: UpstreamErrorMeta }
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = options?.code;
    this.detail = options?.detail;
    this.meta = options?.meta;
  }
}

interface ApiFailureEnvelope {
  success: false;
  error: string;
  code?: string;
  detail?: string;
  meta?: UpstreamErrorMeta;
}

function extractErrorMeta(raw: unknown): UpstreamErrorMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as UpstreamErrorMeta;
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
  body?: unknown;
  onUnauthorized?: 'redirect' | 'throw';
  toastOnError?: boolean;
  skipDedup?: boolean;
}

const inFlightGetRequests = new Map<string, Promise<any>>();

export function redirectToSignIn(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname.startsWith('/auth/')) return;
  toastManager.add({
    type: 'warning',
    title: m.toast_login_required(),
    description: m.toast_login_required_desc(),
  });
  window.location.assign('/auth/signin');
}

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

    if (res.status === 401 && onUnauthorized === 'redirect') {
      redirectToSignIn();
      throw new ApiClientError(401, m.toast_login_required(), { code: 'UNAUTHORIZED' });
    }

    let json: unknown = undefined;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      json = await res.json().catch(() => undefined);
    }

    if (isSuccessEnvelope(json)) {
      return json.data as T;
    }

    if (isFailureEnvelope(json)) {
      const error = new ApiClientError(res.status, json.error, {
        code: json.code,
        detail: json.detail,
        meta: extractErrorMeta(json.meta),
      });
      if (toastOnError) {
        toastManager.add({ type: 'error', title: m.toast_action_failed(), description: json.error });
      }
      throw error;
    }

    if (res.ok && json !== undefined) {
      return json as T;
    }

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
        const rawMeta = extractErrorMeta(jsonObj.meta);
        const error = new ApiClientError(res.status, rawError, {
          code: rawCode,
          detail: rawDetail,
          meta: rawMeta,
        });
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
      .catch(ignoreBestEffort);
  }

  return promise;
}

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
