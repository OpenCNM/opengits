import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 网关边缘执行链（apps/client/src/proxy.ts）单元测试。
 * 契约（向量 11.2.x）：
 * - 🧪 OPTIONS 与 /api/mcp（含子路径）绝对豁免，/api/mcpX 兄弟前缀不豁免
 * - 🧪 扫描器 UA 命中 403 且落拦截事件；开关关闭放行
 * - 🧪 IP 黑名单命中 403；匿名公共端点全局 RPM 超限 429；机器路径豁免 RPM
 * - 🧪 非公开端点无 token 401（JWT 契约不回退）
 */

const policyMocks = vi.hoisted(() => ({
  getGatewayPolicy: vi.fn(),
  isIpBlocked: vi.fn(),
  recordGatewaySecurityEvent: vi.fn(),
}));

const rateLimitMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('@/lib/secrets', () => ({
  resolveSecret: vi.fn(() => 'test-only-secret'),
}));
vi.mock('@/lib/gateway/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gateway/policy')>();
  return {
    ...actual,
    getGatewayPolicy: policyMocks.getGatewayPolicy,
    isIpBlocked: policyMocks.isIpBlocked,
    recordGatewaySecurityEvent: policyMocks.recordGatewaySecurityEvent,
  };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: rateLimitMocks.checkRateLimit,
  };
});

import { proxy } from '@/proxy';
import { getToken } from 'next-auth/jwt';

const DEFAULT_POLICY = {
  emergencyReadOnly: false,
  webApiRpm: 120,
  scannerBlockEnabled: true,
  blockEmptyUserAgent: false,
};

function req(url: string, init?: { method?: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? 'GET',
    headers: init?.headers,
  });
}

/** NextResponse.next() 的可观测特征头 */
function isNextPass(res: Response): boolean {
  return res.headers.get('x-middleware-next') === '1';
}

beforeEach(() => {
  vi.clearAllMocks();
  policyMocks.getGatewayPolicy.mockResolvedValue({ ...DEFAULT_POLICY });
  policyMocks.isIpBlocked.mockResolvedValue(false);
  rateLimitMocks.checkRateLimit.mockResolvedValue(true);
  vi.mocked(getToken).mockResolvedValue(null);
});

describe('client proxy（网关边缘执行链）', () => {
  it('OPTIONS 预检全量直通', async () => {
    const res = await proxy(req('/api/search', { method: 'OPTIONS' }));
    expect(isNextPass(res)).toBe(true);
    expect(policyMocks.getGatewayPolicy).not.toHaveBeenCalled();
  });

  it('🧪 [11.2.1.1] MCP 协议路径精确豁免：本体与子路径直通，且不受扫描器 UA 影响', async () => {
    for (const pathname of ['/api/mcp', '/api/mcp/a/b']) {
      const res = await proxy(
        req(pathname, { headers: { 'user-agent': 'sqlmap/1.0' } })
      );
      expect(isNextPass(res)).toBe(true);
    }
    // 豁免路径上不施加任何策略读取
    expect(policyMocks.getGatewayPolicy).not.toHaveBeenCalled();
  });

  it('🧪 [11.2.1.2] 兄弟前缀 /api/mcpX 不豁免：无 token 时被 JWT 拦截', async () => {
    const res = await proxy(req('/api/mcp-x'));
    expect(res.status).toBe(401);
  });

  it('🧪 [11.2.2.1] 扫描器 UA 命中 403 并落 SCANNER_BLOCK 事件', async () => {
    const res = await proxy(req('/api/search', { headers: { 'user-agent': 'Nikto/2.1.6' } }));
    expect(res.status).toBe(403);
    expect(policyMocks.recordGatewaySecurityEvent).toHaveBeenCalledTimes(1);
    const evt = policyMocks.recordGatewaySecurityEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(evt.kind).toBe('SCANNER_BLOCK');
    expect(evt.path).toBe('/api/search');
  });

  it('扫描器拦截开关关闭时放行（交由 JWT 层 401）', async () => {
    policyMocks.getGatewayPolicy.mockResolvedValue({ ...DEFAULT_POLICY, scannerBlockEnabled: false });
    const res = await proxy(req('/api/search', { headers: { 'user-agent': 'sqlmap/1.0' } }));
    expect(res.status).toBe(401);
    expect(policyMocks.recordGatewaySecurityEvent).not.toHaveBeenCalled();
  });

  it('空 UA 拦截开启时：无 UA 403，机器路径豁免', async () => {
    policyMocks.getGatewayPolicy.mockResolvedValue({ ...DEFAULT_POLICY, blockEmptyUserAgent: true });

    const blocked = await proxy(req('/api/docs-content/a/b'));
    expect(blocked.status).toBe(403);

    const exempt = await proxy(req('/api/health'));
    expect(isNextPass(exempt)).toBe(true);

    const withUa = await proxy(req('/api/docs-content/a/b', { headers: { 'user-agent': 'Mozilla/5.0' } }));
    expect(isNextPass(withUa)).toBe(true);
  });

  it('🧪 [11.2.3.1] IP 黑名单命中 403 并落 IP_BLOCKED 事件', async () => {
    policyMocks.isIpBlocked.mockResolvedValue(true);
    const res = await proxy(
      req('/api/user/preferences', {
        headers: { 'x-forwarded-for': '192.0.2.7, 10.0.0.1', 'user-agent': 'Mozilla/5.0' },
      })
    );
    expect(res.status).toBe(403);
    const evt = policyMocks.recordGatewaySecurityEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(evt.kind).toBe('IP_BLOCKED');
    expect(evt.ipAddress).toBe('192.0.2.7');
  });

  it('🧪 [11.2.3.2] 匿名公共端点全局 RPM 超限 429 并落 RATE_LIMITED 事件', async () => {
    rateLimitMocks.checkRateLimit.mockResolvedValue(false);
    const res = await proxy(
      req('/api/docs-content/a/b', { headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '198.51.100.5' } })
    );
    expect(res.status).toBe(429);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledWith(
      'gateway-web:198.51.100.5',
      120,
      60_000
    );
    const evt = policyMocks.recordGatewaySecurityEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(evt.kind).toBe('RATE_LIMITED');
  });

  it('机器路径豁免 RPM；放行路径直通', async () => {
    const health = await proxy(req('/api/health'));
    expect(isNextPass(health)).toBe(true);
    expect(rateLimitMocks.checkRateLimit).not.toHaveBeenCalled();

    const publicOk = await proxy(
      req('/api/repos/a/view', { headers: { 'user-agent': 'Mozilla/5.0' } })
    );
    expect(isNextPass(publicOk)).toBe(true);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('已登录用户访问公开端点：豁免匿名 IP RPM 限制', async () => {
    vi.mocked(getToken).mockResolvedValue({ sub: 'user-1' } as never);
    rateLimitMocks.checkRateLimit.mockResolvedValue(false);
    const res = await proxy(
      req('/api/docs-content/a/b', { headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '198.51.100.5' } })
    );
    expect(isNextPass(res)).toBe(true);
    expect(rateLimitMocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('非公开端点：无 token 401，有 token 直通（JWT 契约不回退）', async () => {
    const denied = await proxy(req('/api/user/preferences', { headers: { 'user-agent': 'Mozilla/5.0' } }));
    expect(denied.status).toBe(401);

    vi.mocked(getToken).mockResolvedValue({ sub: 'user-1' } as never);
    const allowed = await proxy(req('/api/user/preferences', { headers: { 'user-agent': 'Mozilla/5.0' } }));
    expect(isNextPass(allowed)).toBe(true);
  });
});
