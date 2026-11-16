import { NextRequest, NextResponse } from 'next/server';
import { readBodyJson } from './body-json';
import { createHash } from 'node:crypto';
import { authenticateMcpRequest, getRoleForMcpUser } from './token-auth';
import { McpRateLimiter } from './rate-limiter';

/**
 * ─────────────────────────────────────────────────────────────
 * MCP 端点统一守卫（鉴权 + 配额保护与网关限流）
 *
 * 统一收敛三个入口（单仓 / hub / bundle）的检查顺序：
 *   鉴权（Bearer token / session 双通道）→ 角色 → 配额（封禁/RPM/每日）
 *
 * 语义对齐 MCP 规范：401 必带 WWW-Authenticate: Bearer challenge。
 * Token 传递：首选 Authorization 头；另兼容部分 SSE 客户端以 ?token= / ?apiKey=
 * query 参数传递（见 token-auth.ts extractBearerToken）。注意：query 凭证可能
 * 泄入反代/访问日志，仅作为兼容通道保留，新客户端接入一律走 Header。
 * ─────────────────────────────────────────────────────────────
 */

export interface McpGuardOptions {
  /** true = JSON-RPC 错误体（{jsonrpc, error:{code,message}}），false = REST {error} */
  rpc?: boolean;
  /** 调用方 CORS 头（各路由 methods 不同），守卫会合并进拒绝响应 */
  cors?: Record<string, string>;
}

export interface McpGuardResult {
  /** 鉴权 + 配额全部通过后的用户 ID */
  userId: string;
  /** 用户角色（ADMIN/SUPER_ADMIN 免配额） */
  role: string;
  /** 非 null 时调用方必须直接 return 该响应（401/403/429 拒绝） */
  response: NextResponse | null;
}

// Bearer 挑战附 RFC 9728 resource_metadata 指引：客户端据此发现授权服务器
//（.well-known/oauth-protected-resource → authorization_servers → RFC 8414）
const AUTH_CHALLENGE = {
  'WWW-Authenticate': `Bearer resource_metadata="${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/.well-known/oauth-protected-resource"`,
};

/** Go mcp-sidecar（Phase 2a）透传携带的「已计量」标记头（常量时间令牌签名保护） */
const QUOTA_CHECKED_HEADER = 'x-mcp-quota-checked';

function tokenEquals(provided: string, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return a.length === b.length && a.equals(b);
}

/**
 * mcp-sidecar 边缘已计量判定：请求携带 quota-skip 头且内部令牌签名有效。
 * 该头仅来自 compose 内网的 Go sidecar（x-internal-token sha256 常量时间比对，
 * 与 /api/internal/revalidate 同防线），公网不可伪造——Caddy 已阻断 /api/internal*
 * 且外部无从获知 INTERNAL_API_TOKEN。
 */
function isMeteredBySidecar(req: NextRequest): boolean {
  // headers 可选链：兼容无头部的最小请求形态（单测 fake / 非 HTTP 调用上下文）
  if (req.headers?.get(QUOTA_CHECKED_HEADER) !== '1') return false;
  return tokenEquals(req.headers?.get('x-internal-token') || '', process.env.INTERNAL_API_TOKEN);
}

function unauthorized(options: McpGuardOptions): NextResponse {
  const message = 'Unauthorized: 请先登录后使用 MCP（支持 Bearer API Token 或登录会话）';
  const headers = { ...(options.cors || {}), ...AUTH_CHALLENGE };
  if (options.rpc) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
      { status: 401, headers }
    );
  }
  return NextResponse.json({ error: message }, { status: 401, headers });
}

/**
 * 协议级握手/发现方法（不消耗每日工具调用配额，亦不被配额阻断握手）：
 * initialize, tools/list, prompts/list, resources/list, ping, notifications/*,
 * server/discover（2026-07-28 无状态发现面）
 */
const FREE_PROTOCOL_METHODS = new Set([
  'initialize',
  'tools/list',
  'prompts/list',
  'resources/list',
  'prompts/get',
  // 注意：resources/read 返回文档全文，必须计入 RPM/日配额（曾因列入本集合形成免限流旁路）
  'ping',
  'notifications/initialized',
  'notifications/cancelled',
  // 与 Go sidecar freeProtocolMethods 锁步（server/discover 为 2026-07-28 服务端 MUST）
  'server/discover',
]);

/** 仅鉴权（GET 清单类端点用：只读、不限流） */
export async function enforceMcpAuth(
  req: NextRequest,
  options: McpGuardOptions = {}
): Promise<McpGuardResult> {
  const auth = await authenticateMcpRequest(req);
  if (!auth.userId) {
    return { userId: '', role: '', response: unauthorized(options) };
  }
  const role = await getRoleForMcpUser(auth.userId);
  return { userId: auth.userId, role, response: null };
}

/** 鉴权 + 配额（工具执行类端点用：封禁 / RPM / 每日配额全量检查） */
export async function enforceMcpAuthAndQuota(
  req: NextRequest,
  options: McpGuardOptions = {}
): Promise<McpGuardResult> {
  const authOnly = await enforceMcpAuth(req, options);
  if (authOnly.response) return authOnly;

  // 若为 JSON-RPC 协议级握手或元数据发现请求（如 tools/list, initialize, ping），仅鉴权，不扣减每日工具执行配额
  if (options.rpc) {
    try {
      const body = await readBodyJson(req);
      const method = body?.method;
      if (typeof method === 'string' && FREE_PROTOCOL_METHODS.has(method)) {
        return authOnly;
      }
    } catch {
      // 容错：解析失败继续走标准配额检查
    }
  }

  // mcp-sidecar 边缘（Go）已作为唯一计量点完成 RPM/日配额检查与 ledger increment：
  // 此处跳过以杜绝双重计数（鉴权已在上方照常执行；无有效内部令牌签名时本分支不生效）
  if (isMeteredBySidecar(req)) {
    return authOnly;
  }

  const rateCheck = await McpRateLimiter.checkLimit(authOnly.userId, authOnly.role);
  if (!rateCheck.allowed) {
    return {
      userId: '',
      role: '',
      response: NextResponse.json(rateCheck.errorJson, {
        status: rateCheck.status,
        headers: { ...(options.cors || {}), ...rateCheck.headers },
      }),
    };
  }
  return authOnly;
}
