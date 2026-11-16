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

// Ensure Paraglide Server AsyncLocalStorage is globally registered for API routes
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

/**
 * 路由统一封装（defineRoute）：把 86 条 API 路由各自手写的
 * 鉴权前置 / zod 解析 / 限流 / try-catch / 错误 shape 收敛到一处。
 *
 * 成功响应：{ success: true, data }
 * 失败响应：{ success: false, error, code?, detail? }
 *
 * 逃生舱：SSE / 流式 / 需要自定义响应头的路由不套用本封装，
 * handler 返回 NextResponse 时原样透传。
 */

export type AuthMode = 'public' | 'user' | 'admin' | 'none';

/** handler 的显式成功返回：ok(data)、ok(data, 202) 或 ok(data, { status, headers }) */
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
  /** 动态段（已 await 解包；无动态段的路由为 {}） */
  params: P;
  /** bodySchema 解析产物；未声明 bodySchema 时为 undefined */
  body: B;
  /** 'public' 下可能为 null；'user' 鉴权下自动收窄为 string */
  userId: string | null;
  /** 用户邮箱 */
  userEmail: string | null;
  /** 'admin' 鉴权下的管理员邮箱 */
  adminEmail: string | null;
  /** 当前请求解析出的语言 */
  locale: 'en' | 'zh-CN';
}

interface RateLimitSpec {
  limit: number;
  windowMs: number;
  /** 默认 userId ?? 客户端 IP */
  identifier?: (ctx: { request: NextRequest; userId: string | null }) => string;
}

interface BaseRouteSpec<B> {
  bodySchema?: z.ZodType<B>;
  rateLimit?: RateLimitSpec;
  /** 方法名注入到错误日志 scope，便于观测检索 */
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

/** 与 Next 16 路由签名对齐：params 是 Promise */
export type RouteHandler<P extends Record<string, string>> = (
  request: NextRequest,
  context: { params: Promise<P> }
) => Promise<NextResponse>;

function failureResponse(err: ApiFailure, status: number): NextResponse {
  return NextResponse.json(err, { status });
}

function toFailureEnvelope(err: ApiError): ApiFailure {
  let message = err.message;
  // 若 code 为已知系统标准码且并未携带专有覆盖文案，自动按当前环境解析标准多语言
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
  };
}

/** body 解析：未声明 schema 返回 undefined；声明则严格校验（400 带字段级信息） */
async function parseBody<B>(request: NextRequest, schema: z.ZodType<B>): Promise<B> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // 空/非 JSON body 按空对象处理（与既有路由 .catch(() => ({})) 语义一致）：
    // 全可选字段的 schema（如 reset 的 {force?}）可通过，缺必填字段的由校验报 400
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // schema 作者显式书写的中文文案（如「请选择至少一个章节任务」）是面向终端
    // 用户的契约提示，直接作为 error 透传；zod 缺省英文技术文案（Required 等）
    // 不裸露给用户，回落 i18n 通用文案（Unicode Han 检测，见不变量 5）。
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
        // ── 动态段解包 ──
        const params = (context?.params ? await context.params : {}) as P;

        // ── 鉴权 ──
        const mode = (spec.auth ?? 'public') as AuthMode;
        let userId: string | null = null;
        let userEmail: string | null = null;
        let adminEmail: string | null = null;

        if (mode === 'none') {
          // 纯开放/Fast-Path 路由：彻底跳过 Session 检查与 DB 查询
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

        // ── 限流（fail-open 由 driver 保证；此处只消费布尔结果） ──
        if (spec.rateLimit) {
          const identifier = spec.rateLimit.identifier
            ? spec.rateLimit.identifier({ request, userId })
            : userId ?? clientIpFromRequest(request.headers);
          const allowed = await checkRateLimit(identifier, spec.rateLimit.limit, spec.rateLimit.windowMs);
          if (!allowed) {
            throw ApiError.fromCode('RATE_LIMITED');
          }
        }

        // ── body 解析 ──
        // 未声明 bodySchema 时 B 按约定为 undefined，此处单点收敛该类型边界
        const body = (spec.bodySchema ? await parseBody(request, spec.bodySchema) : undefined) as B;

        // ── 执行 ──
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
          return result; // 逃生舱：流式/自定义响应原样透传
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
        // 未知异常：记录并泛化，避免向客户端泄漏内部错误细节
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
