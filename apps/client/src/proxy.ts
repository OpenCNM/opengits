import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { resolveSecret } from '@/lib/secrets';
import { isPublicApiPath, isMcpProtocolPath } from '@/lib/public-routes';
import { GATEWAY_SCANNER_UA_PATTERNS } from '@/lib/constants';
import {
  getGatewayPolicy,
  isIpBlocked,
  isMachineExemptPath,
  recordGatewaySecurityEvent,
} from '@/lib/gateway/policy';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';

function isMaliciousScanner(userAgent: string): boolean {
  const lower = userAgent.toLowerCase();
  return GATEWAY_SCANNER_UA_PATTERNS.some((pattern) => lower.includes(pattern));
}

// Execution order is a security invariant: OPTIONS and /api/mcp bypass Web JWT, UA, and rate limits
// while policy/IP lookups fail open for availability.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (req.method === 'OPTIONS') {
    return NextResponse.next();
  }

  if (isMcpProtocolPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    const userAgent = req.headers.get('user-agent') || '';
    const clientIp = clientIpFromRequest(req.headers);
    const freqExempt = isMachineExemptPath(pathname);

    const policy = await getGatewayPolicy();

    if (policy.scannerBlockEnabled && userAgent && isMaliciousScanner(userAgent)) {
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: pathname, ipAddress: clientIp, userAgent });
      return NextResponse.json(
        { error: 'Forbidden: Automated security scanner blocked by Gateway Security Center' },
        { status: 403 }
      );
    }

    if (policy.blockEmptyUserAgent && !userAgent && !freqExempt) {
      recordGatewaySecurityEvent({ kind: 'EMPTY_UA_BLOCK', path: pathname, ipAddress: clientIp });
      return NextResponse.json({ error: 'Forbidden: Missing User-Agent' }, { status: 403 });
    }

    if (await isIpBlocked(clientIp)) {
      recordGatewaySecurityEvent({ kind: 'IP_BLOCKED', path: pathname, ipAddress: clientIp, userAgent });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const token = await getToken({
      req,
      secret: resolveSecret(
        'NEXTAUTH_SECRET',
        'dev_only_insecure_nextauth_secret_DO_NOT_USE_IN_PRODUCTION'
      ),
    });

    if (isPublicApiPath(pathname)) {
      const effectiveRpm =
        process.env.NODE_ENV === 'development' ? Math.max(policy.webApiRpm, 3000) : policy.webApiRpm;

      if (!token && !freqExempt && !(await checkRateLimit(`gateway-web:${clientIp}`, effectiveRpm, 60_000))) {
        recordGatewaySecurityEvent({ kind: 'RATE_LIMITED', path: pathname, ipAddress: clientIp, userAgent });
        return NextResponse.json(
          { success: false, error: 'Too Many Requests', code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '60' } }
        );
      }
      return NextResponse.next();
    }

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized access. Please login.' },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
