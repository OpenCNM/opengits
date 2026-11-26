import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { getToken } from 'next-auth/jwt';
import { resolveSecret } from '@/lib/secrets';
import { extractSessionCookieHash, sessionJweCache } from '@/lib/auth-helper';

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
