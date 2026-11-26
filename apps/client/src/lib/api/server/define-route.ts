import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSessionHelper, getAdminUserHelper } from '@/lib/auth-helper';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { captureError } from '@/lib/observability/errors';
import { getServerAsyncLocalStorage, overwriteServerAsyncLocalStorage } from '@/paraglide/runtime.js';
import {
  ApiError,
  ApiErrorCode,
  API_ERROR_CODES,
  ApiFailure,
  ApiSuccess,
  getLocalizedErrorMessage,
} from './api-error';

let serverStorage = getServerAsyncLocalStorage();
if (!serverStorage) {
  serverStorage = new AsyncLocalStorage();
  overwriteServerAsyncLocalStorage(serverStorage);
}

function resolveRequestLocale(request: NextRequest): 'en' | 'zh-CN' {
  const cookie =
    request?.cookies?.get?.('PARAGLIDE_LOCALE')?.value ||
    request?.cookies?.get?.('NEXT_LOCALE')?.value;
  if (cookie === 'zh-CN' || cookie === 'en') return cookie;
  const acceptLang = request?.headers?.get?.('accept-language') || '';
  if (acceptLang.toLowerCase().startsWith('zh')) return 'zh-CN';
  if (acceptLang.toLowerCase().startsWith('en')) return 'en';
  return 'zh-CN';
}

export type AuthMode = 'public' | 'user' | 'admin' | 'none';

export interface OkResult<T> {
  __ok: true;
  data: T;
  status: number;
  headers?: HeadersInit;
}

export function ok<T>(data: T, init?: number | { status?: number; headers?: HeadersInit }): OkResult<T> {
  if (typeof init === 'number') {
    return { __ok: true, data, status: init };
  }
  return { __ok: true, data, status: init?.status ?? 200, headers: init?.headers };
}

export interface RouteContext<P extends Record<string, string>, B> {
  request: NextRequest;
  params: P;
  body: B;
  userId: string | null;
  userEmail: string | null;
  adminEmail: string | null;
  locale: 'en' | 'zh-CN';
}

interface RateLimitSpec {
  limit: number;
  windowMs: number;
  identifier?: (ctx: { request: NextRequest; userId: string | null }) => string;
}

interface BaseRouteSpec<B> {
  bodySchema?: z.ZodType<B>;
  rateLimit?: RateLimitSpec;
  scope: string;
}

export type RouteSpec<P extends Record<string, string>, B> =
  | (BaseRouteSpec<B> & {
      auth: 'user';
      handler: (
        ctx: Omit<RouteContext<P, B>, 'userId' | 'userEmail'> & { userId: string; userEmail: string }
      ) => Promise<OkResult<unknown> | NextResponse | void> | OkResult<unknown> | NextResponse | void;
    })
  | (BaseRouteSpec<B> & {
      auth: 'admin';
      handler: (
        ctx: Omit<RouteContext<P, B>, 'adminEmail' | 'userEmail'> & { adminEmail: string; userEmail: string }
      ) => Promise<OkResult<unknown> | NextResponse | void> | OkResult<unknown> | NextResponse | void;
    })
  | (BaseRouteSpec<B> & {
      auth?: 'public' | 'none';
      handler: (
        ctx: RouteContext<P, B>
      ) => Promise<OkResult<unknown> | NextResponse | void> | OkResult<unknown> | NextResponse | void;
    });

export type RouteHandler<P extends Record<string, string>> = (
  request: NextRequest,
  context: { params: Promise<P> }
) => Promise<NextResponse>;

function failureResponse(err: ApiFailure, status: number): NextResponse {
  return NextResponse.json(err, { status });
}

function toFailureEnvelope(err: ApiError): ApiFailure {
  let message = err.message;
  if (err.code && err.code in API_ERROR_CODES) {
    if (
      !message ||
      message === err.code ||
      message === 'Resource not found' ||
      message === 'Authentication required' ||
      message === 'Insufficient permissions' ||
      message === 'Too many requests, please retry later' ||
      message === 'Service temporarily unavailable' ||
      message === 'Internal Server Error'
    ) {
      message = getLocalizedErrorMessage(err.code as ApiErrorCode);
    }
  }
  return {
    success: false,
    error: message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.detail ? { detail: err.detail } : {}),
    ...(err.meta ? { meta: err.meta } : {}),
  };
}

async function parseBody<B>(request: NextRequest, schema: z.ZodType<B>): Promise<B> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const customMessage =
      issue && /\p{Script=Han}/u.test(issue.message) ? issue.message : undefined;
    throw ApiError.fromCode('VALIDATION_ERROR', {
      ...(customMessage ? { message: customMessage } : {}),
      detail: issue ? `${issue.path.join('.')}: ${issue.message}` : undefined,
    });
  }
  return parsed.data;
}

export function defineRoute<
  P extends Record<string, string> = Record<string, never>,
  B = undefined
>(spec: RouteSpec<P, B>): RouteHandler<P> {
  return async (request, context): Promise<NextResponse> => {
    const scope = spec.scope;
    const locale = resolveRequestLocale(request);

    const execute = async (): Promise<NextResponse> => {
      try {
        const params = (context?.params ? await context.params : {}) as P;

        const mode = (spec.auth ?? 'public') as AuthMode;
        let userId: string | null = null;
        let userEmail: string | null = null;
        let adminEmail: string | null = null;

        if (mode === 'none') {
        } else if (mode === 'user' || mode === 'public') {
          const session = await getSessionHelper();
          userId = session?.user?.id ?? null;
          userEmail = session?.user?.email ?? null;
          if (mode === 'user' && !userId) {
            throw ApiError.fromCode('UNAUTHORIZED');
          }
        } else {
          const admin = await getAdminUserHelper();
          if (!admin) {
            throw ApiError.fromCode('FORBIDDEN', { detail: 'Admin access required' });
          }
          adminEmail = admin.email;
          userEmail = admin.email;
        }

        if (spec.rateLimit) {
          const identifier = spec.rateLimit.identifier
            ? spec.rateLimit.identifier({ request, userId })
            : userId ?? clientIpFromRequest(request.headers);
          const allowed = await checkRateLimit(identifier, spec.rateLimit.limit, spec.rateLimit.windowMs);
          if (!allowed) {
            throw ApiError.fromCode('RATE_LIMITED');
          }
        }

        const body = (spec.bodySchema ? await parseBody(request, spec.bodySchema) : undefined) as B;

        const result = await spec.handler({
          request,
          params,
          body,
          userId: userId as any,
          userEmail: userEmail as any,
          adminEmail: adminEmail as any,
          locale,
        });

        if (result instanceof NextResponse) {
          return result;
        }
        if (result === undefined || result === null) {
          return NextResponse.json({ success: true, data: null } satisfies ApiSuccess<null>);
        }
        return NextResponse.json({ success: true, data: result.data } satisfies ApiSuccess<unknown>, {
          status: result.status,
          headers: result.headers,
        });
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          return failureResponse(toFailureEnvelope(err), err.status);
        }
        await captureError(err, {
          scope,
          extra: { url: request.url, method: request.method },
        });
        return failureResponse(
          { success: false, error: 'Internal Server Error', code: 'INTERNAL_ERROR' },
          500
        );
      }
    };

    if (serverStorage) {
      return (serverStorage as any).run({ locale }, execute);
    }
    return execute();
  };
}
