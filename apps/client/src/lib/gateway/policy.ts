import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * ─────────────────────────────────────────────────────────────
 * 网关安全中心共享策略层（client 网关 / 任务层 / admin 控制台三端共用）。
 *
 * 状态源：GatewayPolicyConfig 单行表 + GatewayBlockedIp 黑名单表（admin 热配置）。
 * 读取契约（credits-config / llm-budget 同款模板）：
 * - 进程内 TTL 微缓存；写侧 invalidate 后最迟一个 TTL 全节点生效
 * - DB 不可用一律降级默认值 / 放行（fail-open），延续「MCP 机器流量零破坏」原则；
 *   失败带短窗负缓存，避免 DB 故障期间每请求空转打库
 * 事件契约：拦截事件 fire-and-forget 落 GatewaySecurityEvent（永不阻塞请求路径），
 * 按 kind+ip 节流防事件风暴。
 * ─────────────────────────────────────────────────────────────
 */

/** 与 Prisma GatewayPolicyConfig 默认值对齐的降级默认策略（fail-open 口径） */
export const DEFAULT_GATEWAY_POLICY = {
  emergencyReadOnly: false,
  webApiRpm: 120,
  scannerBlockEnabled: true,
  blockEmptyUserAgent: false,
} as const;

export const gatewayPolicySchema = z.object({
  emergencyReadOnly: z.boolean(),
  webApiRpm: z.number().int().positive().max(100_000),
  scannerBlockEnabled: z.boolean(),
  blockEmptyUserAgent: z.boolean(),
});
export type GatewayPolicy = z.infer<typeof gatewayPolicySchema>;

export const GATEWAY_SECURITY_EVENT_KINDS = [
  'SCANNER_BLOCK',
  'IP_BLOCKED',
  'RATE_LIMITED',
  'EMPTY_UA_BLOCK',
] as const;
export type GatewaySecurityEventKind = (typeof GATEWAY_SECURITY_EVENT_KINDS)[number];

/** IP 字段校验（封禁名单主键；IPv4/IPv6） */
export const gatewayIpSchema = z.union([z.ipv4(), z.ipv6()]);

/** admin 控制台动作契约（POST /api/admin/gateway） */
export const gatewayActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle_emergency_read_only') }),
  z.object({
    action: z.literal('add_blocked_ip'),
    ip: gatewayIpSchema,
    reason: z.string().max(200).optional(),
  }),
  z.object({ action: z.literal('remove_blocked_ip'), ip: z.string().min(1).max(64) }),
  z.object({ action: z.literal('update_rpm_limit'), rpm: gatewayPolicySchema.shape.webApiRpm }),
]);
/**
 * 网关频控与 UA 规则的永久豁免路径：心跳探针、容器互调（拦掉等于自残）、
 * NextAuth 认证回调（会话检查高频且常走共享出口 IP，进全局 RPM 会误伤共享 NAT）。
 * 与策略开关无关，始终豁免。
 */
export const GATEWAY_MACHINE_EXEMPT_PREFIXES = [
  '/api/health',
  '/api/internal/',
  '/api/webhooks/',
  '/api/auth/',
] as const;

export function isMachineExemptPath(pathname: string): boolean {
  return GATEWAY_MACHINE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

// ── 策略读取（10s TTL；失败负缓存 2s） ──

let policyCache: { value: GatewayPolicy; at: number } | null = null;
let policyFailUntil = 0;
const POLICY_TTL_MS = 10_000;
const POLICY_FAIL_BACKOFF_MS = 2_000;

export async function getGatewayPolicy(): Promise<GatewayPolicy> {
  const now = Date.now();
  if (policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  if (now < policyFailUntil) return { ...DEFAULT_GATEWAY_POLICY };
  try {
    const row = await prisma.gatewayPolicyConfig.findUnique({ where: { id: 'singleton' } });
    const value: GatewayPolicy = row
      ? {
          emergencyReadOnly: row.emergencyReadOnly,
          webApiRpm: row.webApiRpm,
          scannerBlockEnabled: row.scannerBlockEnabled,
          blockEmptyUserAgent: row.blockEmptyUserAgent,
        }
      : { ...DEFAULT_GATEWAY_POLICY };
    policyCache = { value, at: Date.now() };
    return value;
  } catch (err) {
    policyFailUntil = Date.now() + POLICY_FAIL_BACKOFF_MS;
    console.warn(
      '[gateway/policy] policy read failed, fail-open defaults:',
      err instanceof Error ? err.message : err
    );
    return { ...DEFAULT_GATEWAY_POLICY };
  }
}

/** admin 写侧入口：写库后调用，立即刷新本进程缓存与其余节点等 TTL（也清除故障退避） */
export function invalidateGatewayPolicyCache(): void {
  policyCache = null;
  policyFailUntil = 0;
  blockedIpsCache = null;
  blockedIpsFailUntil = 0;
}

/** 紧急只读熔断判定（任务层认领单点与新重任务提交口消费） */
export async function isEmergencyReadOnly(): Promise<boolean> {
  return (await getGatewayPolicy()).emergencyReadOnly;
}

// ── IP 黑名单（15s TTL；失败放行） ──

let blockedIpsCache: { value: Set<string>; at: number } | null = null;
let blockedIpsFailUntil = 0;
const BLOCKED_IPS_TTL_MS = 15_000;
const BLOCKED_IPS_FAIL_BACKOFF_MS = 5_000;

/**
 * 规范化 IP 地址：剥离 IPv4 映射前缀 (::ffff:)、端口号后缀与首尾空格。
 * 防范恶意客户端通过异形 IP 书写方式绕过黑名单封禁。
 */
export function normalizeIpAddress(rawIp: string): string {
  if (!rawIp || typeof rawIp !== 'string') return '';
  let ip = rawIp.trim();
  // 1. 去除 IPv4 映射前缀 ::ffff:
  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  // 2. 去除括号包裹的 IPv6 端口 [::1]:8080
  if (ip.startsWith('[') && ip.includes(']')) {
    const end = ip.indexOf(']');
    ip = ip.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    // 3. 去除标准 IPv4 端口 1.2.3.4:8080
    ip = ip.split(':')[0];
  }
  return ip.trim();
}

export async function isIpBlocked(rawIp: string | null | undefined): Promise<boolean> {
  if (!rawIp || rawIp === 'unknown') return false;
  const ip = normalizeIpAddress(rawIp);
  if (!ip || ip === 'unknown') return false;
  const now = Date.now();
  if (blockedIpsCache && now - blockedIpsCache.at < BLOCKED_IPS_TTL_MS) {
    return blockedIpsCache.value.has(ip) || blockedIpsCache.value.has(rawIp);
  }
  if (now < blockedIpsFailUntil) return false;
  try {
    const rows = await prisma.gatewayBlockedIp.findMany({ select: { ipAddress: true } });
    blockedIpsCache = { value: new Set(rows.map((r) => r.ipAddress)), at: Date.now() };
    return blockedIpsCache.value.has(ip) || blockedIpsCache.value.has(rawIp);
  } catch (err) {
    blockedIpsFailUntil = Date.now() + BLOCKED_IPS_FAIL_BACKOFF_MS;
    console.warn(
      '[gateway/policy] blocked-ip read failed, fail-open:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/** admin 黑名单列表（直读，无缓存——控制台要求即时一致） */
export function getBlockedIpEntries() {
  return prisma.gatewayBlockedIp.findMany({ orderBy: { createdAt: 'desc' } });
}

// ── 拦截事件流水（fire-and-forget + 节流） ──

interface SecurityEventInput {
  kind: GatewaySecurityEventKind;
  path: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  detail?: Prisma.InputJsonValue;
}

const EVENT_THROTTLE_MS = 10_000;
const EVENT_THROTTLE_MAP_CAP = 2000;
const eventThrottle = new Map<string, number>();

/**
 * 记录一次网关拦截事件。非阻塞：DB 写失败静默吞掉（安全事件丢失可接受，
 * 请求路径卡死不可接受）；同 kind+ip 10s 内只落一条，防攻击面打爆事件表。
 */
export function recordGatewaySecurityEvent(evt: SecurityEventInput): void {
  const key = `${evt.kind}:${evt.ipAddress ?? '-'}`;
  const now = Date.now();
  if (now - (eventThrottle.get(key) ?? 0) < EVENT_THROTTLE_MS) return;
  eventThrottle.set(key, now);
  if (eventThrottle.size > EVENT_THROTTLE_MAP_CAP) {
    // Map 迭代序即插入序：清掉最旧的一半键位，防极端攻击面下无界增长
    for (const k of eventThrottle.keys()) {
      eventThrottle.delete(k);
      if (eventThrottle.size <= EVENT_THROTTLE_MAP_CAP / 2) break;
    }
  }
  void prisma.gatewaySecurityEvent
    .create({
      data: {
        kind: evt.kind,
        path: evt.path.slice(0, 512),
        ipAddress: evt.ipAddress && evt.ipAddress !== 'unknown' ? evt.ipAddress : null,
        userAgent: evt.userAgent ? evt.userAgent.slice(0, 256) : null,
        detail: evt.detail,
      },
    })
    .catch(() => undefined);
}

// ── admin「网关安全中心」GET 聚合 read model（route 产出、页面消费的单一事实源） ──

export interface GatewayBlockedIpView {
  ipAddress: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface GatewayEventView {
  id: string;
  timestamp: string;
  kind: string;
  ip: string;
  path: string;
  userAgent: string | null;
}

export interface GatewayOverviewData {
  policy: GatewayPolicy;
  blockedIps: GatewayBlockedIpView[];
  recentEvents: GatewayEventView[];
  /** 24h 分 kind 拦截计数（kind → 次数） */
  eventCounts24h: Array<{ kind: string; count: number }>;
  totalInterceptions24h: number;
  mcpFleetSummary: {
    totalFleet: number;
    activeFleet: number;
    pausedFleet: number;
    totalCalls: number;
  };
  /** 最近 5 分钟活跃 MCP 会话数（「MCP 专属通道」横幅的真实数据源） */
  mcpActiveSessions5m: number;
}
