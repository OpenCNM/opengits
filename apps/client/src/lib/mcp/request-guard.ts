import { NextRequest, NextResponse } from 'next/server';
import { ignoreBestEffort } from '@/lib/best-effort';
import { readBodyJson } from './body-json';
import { createHash } from 'node:crypto';
import { authenticateMcpRequest, getRoleForMcpUser } from './token-auth';
import { McpRateLimiter } from './rate-limiter';

export interface McpGuardOptions {
  rpc?: boolean;
  cors?: Record<string, string>;
}

export interface McpGuardResult {
  userId: string;
  role: string;
  response: NextResponse | null;
}

const AUTH_CHALLENGE = {
  'WWW-Authenticate': `Bearer resource_metadata="${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/.well-known/oauth-protected-resource"`,
};

const QUOTA_CHECKED_HEADER = 'x-mcp-quota-checked';

function tokenEquals(provided: string, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return a.length === b.length && a.equals(b);
}

// Trust x-mcp-quota-checked only when paired with a valid internal HMAC/token from Go sidecar.
function isMeteredBySidecar(req: NextRequest): boolean {
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

const FREE_PROTOCOL_METHODS = new Set([
  'initialize',
  'tools/list',
  'prompts/list',
  'resources/list',
  'prompts/get',
  // resources/read returns full documents and must count toward RPM and daily quotas.
  'ping',
  'notifications/initialized',
  'notifications/cancelled',
  'server/discover',
]);

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

export async function enforceMcpAuthAndQuota(
  req: NextRequest,
  options: McpGuardOptions = {}
): Promise<McpGuardResult> {
  const authOnly = await enforceMcpAuth(req, options);
  if (authOnly.response) return authOnly;

  if (options.rpc) {
    try {
      const body = await readBodyJson(req);
      const method = body?.method;
      if (typeof method === 'string' && FREE_PROTOCOL_METHODS.has(method)) {
        return authOnly;
      }
    } catch {
      ignoreBestEffort();
    }
  }

  // Skip quota increment when already metered at the Go sidecar edge to prevent double counting.
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
