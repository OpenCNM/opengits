import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { getToken } from 'next-auth/jwt';
import { resolveSecret } from '@/lib/secrets';
import { extractSessionCookieHash, sessionJweCache } from '@/lib/auth-helper';

/**
 * ─────────────────────────────────────────────────────────────
 * 内部会话校验端点（Milestone 2）：供 Go SSE 网关跨进程校验客户端 session-token。
 *
 * POST /api/internal/auth/verify-session
 *   x-internal-token: <INTERNAL_API_TOKEN>
 *   Body: { cookie?: string } 或直接通过 Cookie 请求头传入
 *   Response: { valid: true, userId: string, email: string | null, name: string | null }
 *           | { valid: false, error: string } (401)
 *
 * 铁律：
 * - 仅 compose 内网可达，受 internalAuthGuard 严格保护
 * - 结果由 Go SSE 网关在内存中按 sha256(cookie) 缓存 5 分钟，避免高频请求打压 Node
 * - 与 getSessionHelper 共享 Node 进程级 sessionJweCache，长连接鉴权微秒级命中
 * ─────────────────────────────────────────────────────────────
 */

function parseCookieString(raw: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { cookie?: string };
  const rawCookie = body?.cookie || req.headers.get('cookie') || '';

  if (!rawCookie) {
    return NextResponse.json({ valid: false, error: 'No session cookie provided' }, { status: 401 });
  }

  const cookieMap = parseCookieString(rawCookie);
  const cookieEntries = Object.entries(cookieMap).map(([name, value]) => ({ name, value }));
  const cookieHash = extractSessionCookieHash(cookieEntries);

  if (!cookieHash) {
    return NextResponse.json({ valid: false, error: 'No session cookie provided' }, { status: 401 });
  }

  // 1. 优先命中与 getSessionHelper 共享的进程内 sessionJweCache
  const cached = sessionJweCache.get(cookieHash);
  if (cached !== undefined) {
    if (!cached?.user?.id) {
      return NextResponse.json({ valid: false, error: 'Invalid or expired session' }, { status: 401 });
    }
    return NextResponse.json({
      valid: true,
      userId: cached.user.id,
      email: cached.user.email ?? null,
      name: cached.user.name ?? null,
    });
  }

  const forwardHeaders = new Headers();
  forwardHeaders.set('cookie', rawCookie);
  const syntheticReq = {
    headers: forwardHeaders,
    cookies: {
      get(name: string) {
        const val = cookieMap[name];
        return val !== undefined ? { name, value: val } : undefined;
      },
      getAll() {
        return cookieEntries;
      },
    },
  } as unknown as NextRequest;

  try {
    const token = await getToken({
      req: syntheticReq,
      secret: resolveSecret('NEXTAUTH_SECRET', 'dev_only_insecure_nextauth_secret_DO_NOT_USE_IN_PRODUCTION'),
    });

    if (!token?.sub) {
      sessionJweCache.set(cookieHash, null);
      return NextResponse.json({ valid: false, error: 'Invalid or expired session' }, { status: 401 });
    }

    // 写入共享缓存，后续 Web 请求与长连接反查均微秒级命中
    sessionJweCache.set(cookieHash, {
      user: {
        id: token.sub,
        email: token.email ?? undefined,
        name: token.name ?? undefined,
      },
      expires: '',
    });

    return NextResponse.json({
      valid: true,
      userId: token.sub,
      email: token.email ?? null,
      name: token.name ?? null,
    });
  } catch (err) {
    console.error('[verify-session] Failed to verify token:', err);
    sessionJweCache.set(cookieHash, null);
    return NextResponse.json({ valid: false, error: 'Session verification failed' }, { status: 401 });
  }
}
