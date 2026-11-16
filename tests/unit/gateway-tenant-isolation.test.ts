import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  gatewayBlockedIp: {
    findMany: vi.fn(),
  },
  document: {
    findUnique: vi.fn(),
  },
  repository: {
    findUnique: vi.fn(),
  },
  savedRepo: {
    findFirst: vi.fn(),
  },
};

vi.mock('@/lib/db', () => ({
  prisma: mockPrisma,
}));

describe('M11 网关安全中心与租户隔离防御 (Unit 11.1, 11.2 & Tenant Isolation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('网关 IP 规范化与黑名单多格式防绕过', () => {
    it('🧪 [11.1.2.1] normalizeIpAddress 准确剥离端口号、IPv4 映射前缀与空格', async () => {
      const { normalizeIpAddress } = await import('@/lib/gateway/policy');

      expect(normalizeIpAddress('192.168.1.100')).toBe('192.168.1.100');
      expect(normalizeIpAddress('  192.168.1.100  ')).toBe('192.168.1.100');
      // 剥离标准 IPv4 端口
      expect(normalizeIpAddress('192.168.1.100:8080')).toBe('192.168.1.100');
      // 剥离 IPv4-mapped 格式
      expect(normalizeIpAddress('::ffff:192.168.1.100')).toBe('192.168.1.100');
      // 剥离带端口的 IPv6
      expect(normalizeIpAddress('[2001:db8::1]:8443')).toBe('2001:db8::1');
      // 异常输入安全降级
      expect(normalizeIpAddress('')).toBe('');
      expect(normalizeIpAddress(null as unknown as string)).toBe('');
    });

    it('🧪 [11.1.2.2] isIpBlocked 对带端口或 ::ffff: 的异形 IP 成功命中封禁，未封禁与 unknown 安全放行', async () => {
      const { isIpBlocked, invalidateGatewayPolicyCache } = await import('@/lib/gateway/policy');
      invalidateGatewayPolicyCache();

      mockPrisma.gatewayBlockedIp.findMany.mockResolvedValueOnce([
        { ipAddress: '203.0.113.50' },
        { ipAddress: '198.51.100.1' },
      ]);

      // 1. 标准封禁 IP 命中
      expect(await isIpBlocked('203.0.113.50')).toBe(true);

      // 2. 携带端口号的相同 IP 依然命中（防端口绕过）
      expect(await isIpBlocked('203.0.113.50:49152')).toBe(true);

      // 3. IPv4-mapped 格式的相同 IP 依然命中（防协议格式绕过）
      expect(await isIpBlocked('::ffff:203.0.113.50')).toBe(true);

      // 4. 未封禁的 IP 放行
      expect(await isIpBlocked('8.8.8.8')).toBe(false);

      // 5. 空值或 unknown 快速放行且不打库
      expect(await isIpBlocked(null)).toBe(false);
      expect(await isIpBlocked('')).toBe(false);
      expect(await isIpBlocked('unknown')).toBe(false);
    });
  });

  describe('多租户数据可见性与 IDOR 越权隔离防御', () => {
    it('🧪 [11.2.3.1] docVisibilityFilter 严格隔离租户私有文档，对游客与空值降级共享正典', async () => {
      const { docVisibilityFilter } = await import('@/lib/auth-utils');

      // 1. 登录用户：允许访问共享正典 (null) + 属于本人的私有副本
      expect(docVisibilityFilter('user-alice')).toEqual({
        OR: [{ ownerUserId: null }, { ownerUserId: 'user-alice' }],
      });

      // 2. 游客模式（null / undefined）：仅允许访问共享正典 (null)
      expect(docVisibilityFilter(null)).toEqual({ ownerUserId: null });
      expect(docVisibilityFilter(undefined)).toEqual({ ownerUserId: null });

      // 3. 空白字符串安全收敛为游客模式（防空字符串穿透）
      expect(docVisibilityFilter('')).toEqual({ ownerUserId: null });
      expect(docVisibilityFilter('   ')).toEqual({ ownerUserId: null });
    });

    it('🧪 [11.2.3.2] checkDocumentAccess 严格阻断跨租户私有文档越权访问 (IDOR 403)', async () => {
      const { checkDocumentAccess } = await import('@/lib/auth-utils');

      // 场景 1：租户 Alice 尝试访问租户 Bob 的私有文档 -> 拒绝
      mockPrisma.document.findUnique.mockResolvedValueOnce({
        repositoryId: 'repo-1',
        ownerUserId: 'user-bob',
      });
      expect(await checkDocumentAccess('doc-bob-private', 'user-alice')).toBe(false);

      // 场景 2：游客尝试访问租户 Bob 的私有文档 -> 拒绝
      mockPrisma.document.findUnique.mockResolvedValueOnce({
        repositoryId: 'repo-1',
        ownerUserId: 'user-bob',
      });
      expect(await checkDocumentAccess('doc-bob-private')).toBe(false);

      // 场景 3：租户 Bob 访问自己的私有文档且公开仓 -> 放行
      mockPrisma.document.findUnique.mockResolvedValueOnce({
        repositoryId: 'repo-1',
        ownerUserId: 'user-bob',
      });
      mockPrisma.repository.findUnique.mockResolvedValueOnce({
        id: 'repo-1',
        isPublic: true,
      });
      expect(await checkDocumentAccess('doc-bob-private', 'user-bob')).toBe(true);

      // 场景 4：访问共享正典文档（ownerUserId 为 null）且公开仓 -> 放行
      mockPrisma.document.findUnique.mockResolvedValueOnce({
        repositoryId: 'repo-1',
        ownerUserId: null,
      });
      mockPrisma.repository.findUnique.mockResolvedValueOnce({
        id: 'repo-1',
        isPublic: true,
      });
      expect(await checkDocumentAccess('doc-public-standard', 'user-alice')).toBe(true);
    });
  });

  describe('MCP 机器协议精确豁免与防搭便车边界', () => {
    it('🧪 [11.2.1.2] isMcpProtocolPath 精确豁免 /api/mcp 本体及子路径，严格拦截兄弟前缀伪装', async () => {
      const { isMcpProtocolPath } = await import('@/lib/public-routes');

      // 1. 合法 MCP 路径放行
      expect(isMcpProtocolPath('/api/mcp')).toBe(true);
      expect(isMcpProtocolPath('/api/mcp/')).toBe(true);
      expect(isMcpProtocolPath('/api/mcp/sse')).toBe(true);
      expect(isMcpProtocolPath('/api/mcp/tools/call')).toBe(true);

      // 2. 试图以兄弟前缀搭便车绕过鉴权的路径被严格拒绝
      expect(isMcpProtocolPath('/api/mcp-test')).toBe(false);
      expect(isMcpProtocolPath('/api/mcp_admin')).toBe(false);
      expect(isMcpProtocolPath('/api/mcpX')).toBe(false);
      expect(isMcpProtocolPath('/api/mcp-proxy')).toBe(false);
    });
  });
});
