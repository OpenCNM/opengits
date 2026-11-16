import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 网关策略共享层（lib/gateway/policy）单元测试。
 * 契约（向量 11.1.x）：
 * - 🧪 DB 读取失败 → 降级默认策略放行（fail-open），并带短窗负缓存防空转打库
 * - 🧪 IP 黑名单命中/未命中；读取失败放行
 * - 🧪 拦截事件 fire-and-forget：写失败静默、同 kind+ip 节流
 */

const prismaMocks = vi.hoisted(() => ({
  gatewayPolicyConfig: { findUnique: vi.fn() },
  gatewayBlockedIp: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
  gatewaySecurityEvent: { create: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMocks }));

import {
  DEFAULT_GATEWAY_POLICY,
  getGatewayPolicy,
  isEmergencyReadOnly,
  isIpBlocked,
  isMachineExemptPath,
  invalidateGatewayPolicyCache,
  recordGatewaySecurityEvent,
  gatewayActionSchema,
  gatewayPolicySchema,
} from '@/lib/gateway/policy';

describe('gateway policy（网关策略共享层）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T10:00:00Z'));
    vi.clearAllMocks();
    invalidateGatewayPolicyCache();
    prismaMocks.gatewaySecurityEvent.create.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getGatewayPolicy / isEmergencyReadOnly', () => {
    it('🧪 [11.1.1.1] DB 行存在时映射全部策略字段并缓存', async () => {
      prismaMocks.gatewayPolicyConfig.findUnique.mockResolvedValue({
        emergencyReadOnly: true,
        webApiRpm: 60,
        scannerBlockEnabled: false,
        blockEmptyUserAgent: true,
      });

      await expect(getGatewayPolicy()).resolves.toEqual({
        emergencyReadOnly: true,
        webApiRpm: 60,
        scannerBlockEnabled: false,
        blockEmptyUserAgent: true,
      });
      await expect(isEmergencyReadOnly()).resolves.toBe(true);
      // TTL 内第二次读取不再打库
      expect(prismaMocks.gatewayPolicyConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it('DB 无行时返回默认策略（fail-open 基线）', async () => {
      prismaMocks.gatewayPolicyConfig.findUnique.mockResolvedValue(null);
      await expect(getGatewayPolicy()).resolves.toEqual({ ...DEFAULT_GATEWAY_POLICY });
    });

    it('🧪 [11.1.1.2] DB 抛错时降级默认策略并负缓存 2s', async () => {
      prismaMocks.gatewayPolicyConfig.findUnique.mockRejectedValue(new Error('db down'));

      await expect(getGatewayPolicy()).resolves.toEqual({ ...DEFAULT_GATEWAY_POLICY });
      expect(prismaMocks.gatewayPolicyConfig.findUnique).toHaveBeenCalledTimes(1);

      // 负缓存窗口内不重复打库
      await getGatewayPolicy();
      expect(prismaMocks.gatewayPolicyConfig.findUnique).toHaveBeenCalledTimes(1);

      // 超过退避窗口后恢复尝试
      vi.advanceTimersByTime(2_100);
      await getGatewayPolicy();
      expect(prismaMocks.gatewayPolicyConfig.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('isIpBlocked', () => {
    it('空/unknown IP 直接放行，不打库', async () => {
      await expect(isIpBlocked(null)).resolves.toBe(false);
      await expect(isIpBlocked('unknown')).resolves.toBe(false);
      expect(prismaMocks.gatewayBlockedIp.findMany).not.toHaveBeenCalled();
    });

    it('🧪 [11.1.2.1] 命中黑名单返回 true，名单缓存复用', async () => {
      prismaMocks.gatewayBlockedIp.findMany.mockResolvedValue([
        { ipAddress: '192.0.2.7' },
        { ipAddress: '2001:db8::1' },
      ]);

      await expect(isIpBlocked('192.0.2.7')).resolves.toBe(true);
      await expect(isIpBlocked('2001:db8::1')).resolves.toBe(true);
      await expect(isIpBlocked('203.0.113.9')).resolves.toBe(false);
      expect(prismaMocks.gatewayBlockedIp.findMany).toHaveBeenCalledTimes(1);
    });

    it('DB 抛错时放行（fail-open）', async () => {
      prismaMocks.gatewayBlockedIp.findMany.mockRejectedValue(new Error('db down'));
      await expect(isIpBlocked('192.0.2.7')).resolves.toBe(false);
    });
  });

  describe('recordGatewaySecurityEvent', () => {
    it('🧪 [11.1.3.1] fire-and-forget：同 kind+ip 10s 节流，不同 IP 不受影响', async () => {
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: '/api/search', ipAddress: '192.0.2.7' });
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: '/api/search', ipAddress: '192.0.2.7' });
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: '/api/search', ipAddress: '192.0.2.8' });

      expect(prismaMocks.gatewaySecurityEvent.create).toHaveBeenCalledTimes(2);

      // 节流窗过后可再次落库
      vi.advanceTimersByTime(10_100);
      recordGatewaySecurityEvent({ kind: 'SCANNER_BLOCK', path: '/api/search', ipAddress: '192.0.2.7' });
      expect(prismaMocks.gatewaySecurityEvent.create).toHaveBeenCalledTimes(3);
    });

    it('写失败静默吞掉（不阻塞请求路径）', async () => {
      prismaMocks.gatewaySecurityEvent.create.mockRejectedValue(new Error('db down'));
      expect(() =>
        recordGatewaySecurityEvent({ kind: 'RATE_LIMITED', path: '/api/repos/a/view', ipAddress: '192.0.2.9' })
      ).not.toThrow();
    });
  });

  describe('isMachineExemptPath 与 schema', () => {
    it('心跳/互调/webhook/认证回调豁免；其余路径不豁免', () => {
      expect(isMachineExemptPath('/api/health')).toBe(true);
      expect(isMachineExemptPath('/api/internal/revalidate')).toBe(true);
      expect(isMachineExemptPath('/api/webhooks/github')).toBe(true);
      expect(isMachineExemptPath('/api/auth/session')).toBe(true);
      expect(isMachineExemptPath('/api/search')).toBe(false);
      expect(isMachineExemptPath('/api/docs-content/a/b')).toBe(false);
    });

    it('gatewayActionSchema 拒绝非法 IP 与未知动作', () => {
      expect(gatewayActionSchema.safeParse({ action: 'add_blocked_ip', ip: 'not-an-ip' }).success).toBe(false);
      expect(gatewayActionSchema.safeParse({ action: 'add_blocked_ip', ip: '192.0.2.7' }).success).toBe(true);
      expect(gatewayActionSchema.safeParse({ action: 'add_blocked_ip', ip: '2001:db8::1' }).success).toBe(true);
      expect(gatewayActionSchema.safeParse({ action: 'destroy_world' }).success).toBe(false);
      expect(gatewayActionSchema.safeParse({ action: 'update_rpm_limit', rpm: 0 }).success).toBe(false);
      expect(gatewayActionSchema.safeParse({ action: 'update_rpm_limit', rpm: 300 }).success).toBe(true);
      expect(gatewayPolicySchema.safeParse({ ...DEFAULT_GATEWAY_POLICY }).success).toBe(true);
    });
  });
});
