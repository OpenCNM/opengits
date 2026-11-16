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

/**
 * 应用级网关（Node runtime Proxy）。执行序即安全序：
 * OPTIONS 直通 → MCP 协议精确豁免 → 扫描器 UA → 空 UA → IP 黑名单 →
 * 匿名公共接口全局 RPM → 公开白名单放行 → Web JWT。
 *
 * 铁律：
 * - 全部判定 fail-open（策略库/Redis 故障一律放行，可用性优先）
 * - `/api/mcp` 机器流量零干扰：不做 Web 会话拦截、不施加 UA 规则、不碰流式响应
 *   （Caddy 已把 /api/mcp* 分流至独立 mcp 容器，此处为纵深防御层）
 * - 拦截动作 fire-and-forget 落 GatewaySecurityEvent，绝不阻塞请求路径
 */

function isMaliciousScanner(userAgent: string): boolean {
  const lower = userAgent.toLowerCase();
  return GATEWAY_SCANNER_UA_PATTERNS.some((pattern) => lower.includes(pattern));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. CORS 预检请求全量直通（Web IDE / Electron 握手）
  if (req.method === 'OPTIONS') {
    return NextResponse.next();
  }

  // 2. MCP 机器协议流量精确豁免（原生 Bearer/Query Token 自鉴权 + SSE 零缓冲）
  if (isMcpProtocolPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    const userAgent = req.headers.get('user-agent') || '';
    const clientIp = clientIpFromRequest(req.headers);
    const freqExempt = isMachineExemptPath(pathname);

    // 3. 策略快照（10s TTL；读取失败降级默认策略，绝不因策略库故障阻断请求）
    const policy = await getGatewayPolicy();

    // 4. 恶意扫描器前置拦截（仅普通 Web API；UA 规则不触碰 MCP 通道）
    if (policy.scannerBlockEnabled && userAgent && isMaliciousScanner(userAgent)) {
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: pathname, ipAddress: clientIp, userAgent });
      return NextResponse.json(
        { error: 'Forbidden: Automated security scanner blocked by Gateway Security Center' },
        { status: 403 }
      );
    }

    // 5. 空 UA 拦截（默认关；探针/互调/认证回调路径永久豁免）
    if (policy.blockEmptyUserAgent && !userAgent && !freqExempt) {
      recordGatewaySecurityEvent({ kind: 'EMPTY_UA_BLOCK', path: pathname, ipAddress: clientIp });
      return NextResponse.json({ error: 'Forbidden: Missing User-Agent' }, { status: 403 });
    }

    // 6. IP 黑名单（全站 API 含登录态路径；名单走 TTL 缓存，fail-open）
    if (await isIpBlocked(clientIp)) {
      recordGatewaySecurityEvent({ kind: 'IP_BLOCKED', path: pathname, ipAddress: clientIp, userAgent });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 7. 生产缺 NEXTAUTH_SECRET 时 fail-fast（历史硬编码兜底可伪造 JWT 绕过本代理）
    const token = await getToken({
      req,
      secret: resolveSecret(
        'NEXTAUTH_SECRET',
        'dev_only_insecure_nextauth_secret_DO_NOT_USE_IN_PRODUCTION'
      ),
    });

    // 8. 公开白名单端点：登录用户持有合法会话直接放行；匿名访客施加按 IP 全局滑动窗口 RPM 防爬
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
