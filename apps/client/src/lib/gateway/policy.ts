import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

// DB outages fail open with short negative caching to protect machine traffic; security events are fire-and-forget and throttled.

export const RUNTIME_CONCURRENCY_BOUNDS = {
  transcriptionConcurrency: { min: 1, max: 32, defaultValue: 3 },
  transcriptionChunkConcurrency: { min: 1, max: 16, defaultValue: 3 },
  llmUserConcurrency: { min: 1, max: 32, defaultValue: 3 },
  llmInteractiveHeadroom: { min: 0, max: 8, defaultValue: 1 },
} as const;

export type RuntimeConcurrencySource = 'policy' | 'env' | 'default';

export interface RuntimeConcurrencyValues {
  transcriptionConcurrency: number;
  transcriptionChunkConcurrency: number;
  llmUserConcurrency: number;
  llmInteractiveHeadroom: number;
}

export interface RuntimeConcurrencyOverrides {
  transcriptionConcurrency: number | null;
  transcriptionChunkConcurrency: number | null;
  llmUserConcurrency: number | null;
  llmInteractiveHeadroom: number | null;
}

export interface EffectiveRuntimeConcurrency {
  effective: RuntimeConcurrencyValues;
  overrides: RuntimeConcurrencyOverrides;
  sources: Record<keyof RuntimeConcurrencyValues, RuntimeConcurrencySource>;
  batchLimit: number;
}

const nullableBoundedInt = (min: number, max: number) =>
  z.number().int().min(min).max(max).nullable();

export const runtimeConcurrencyUpdateSchema = z
  .object({
    transcriptionConcurrency: nullableBoundedInt(
      RUNTIME_CONCURRENCY_BOUNDS.transcriptionConcurrency.min,
      RUNTIME_CONCURRENCY_BOUNDS.transcriptionConcurrency.max,
    ).optional(),
    transcriptionChunkConcurrency: nullableBoundedInt(
      RUNTIME_CONCURRENCY_BOUNDS.transcriptionChunkConcurrency.min,
      RUNTIME_CONCURRENCY_BOUNDS.transcriptionChunkConcurrency.max,
    ).optional(),
    llmUserConcurrency: nullableBoundedInt(
      RUNTIME_CONCURRENCY_BOUNDS.llmUserConcurrency.min,
      RUNTIME_CONCURRENCY_BOUNDS.llmUserConcurrency.max,
    ).optional(),
    llmInteractiveHeadroom: nullableBoundedInt(
      RUNTIME_CONCURRENCY_BOUNDS.llmInteractiveHeadroom.min,
      RUNTIME_CONCURRENCY_BOUNDS.llmInteractiveHeadroom.max,
    ).optional(),
  })
  .refine(
    (v) =>
      v.transcriptionConcurrency !== undefined ||
      v.transcriptionChunkConcurrency !== undefined ||
      v.llmUserConcurrency !== undefined ||
      v.llmInteractiveHeadroom !== undefined,
    { message: '至少提供一项待更新的并发参数' },
  );

export type RuntimeConcurrencyUpdateInput = z.infer<typeof runtimeConcurrencyUpdateSchema>;

export const DEFAULT_GATEWAY_POLICY = {
  emergencyReadOnly: false,
  webApiRpm: 120,
  scannerBlockEnabled: true,
  blockEmptyUserAgent: false,
  transcriptionConcurrency: null as number | null,
  transcriptionChunkConcurrency: null as number | null,
  llmUserConcurrency: null as number | null,
  llmInteractiveHeadroom: null as number | null,
} as const;

export const gatewayPolicySchema = z.object({
  emergencyReadOnly: z.boolean(),
  webApiRpm: z.number().int().positive().max(100_000),
  scannerBlockEnabled: z.boolean(),
  blockEmptyUserAgent: z.boolean(),
  transcriptionConcurrency: nullableBoundedInt(
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionConcurrency.min,
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionConcurrency.max,
  ),
  transcriptionChunkConcurrency: nullableBoundedInt(
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionChunkConcurrency.min,
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionChunkConcurrency.max,
  ),
  llmUserConcurrency: nullableBoundedInt(
    RUNTIME_CONCURRENCY_BOUNDS.llmUserConcurrency.min,
    RUNTIME_CONCURRENCY_BOUNDS.llmUserConcurrency.max,
  ),
  llmInteractiveHeadroom: nullableBoundedInt(
    RUNTIME_CONCURRENCY_BOUNDS.llmInteractiveHeadroom.min,
    RUNTIME_CONCURRENCY_BOUNDS.llmInteractiveHeadroom.max,
  ),
});
export type GatewayPolicy = z.infer<typeof gatewayPolicySchema>;

export const GATEWAY_SECURITY_EVENT_KINDS = [
  'SCANNER_BLOCK',
  'IP_BLOCKED',
  'RATE_LIMITED',
  'EMPTY_UA_BLOCK',
] as const;
export type GatewaySecurityEventKind = (typeof GATEWAY_SECURITY_EVENT_KINDS)[number];

export const gatewayIpSchema = z.union([z.ipv4(), z.ipv6()]);

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
// Always exempt health probes, internal sidecar calls, and NextAuth callbacks (shared NATs would trip global RPM).
export const GATEWAY_MACHINE_EXEMPT_PREFIXES = [
  '/api/health',
  '/api/internal/',
  '/api/webhooks/',
  '/api/auth/',
] as const;

export function isMachineExemptPath(pathname: string): boolean {
  return GATEWAY_MACHINE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

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
          transcriptionConcurrency: row.transcriptionConcurrency ?? null,
          transcriptionChunkConcurrency: row.transcriptionChunkConcurrency ?? null,
          llmUserConcurrency: row.llmUserConcurrency ?? null,
          llmInteractiveHeadroom: row.llmInteractiveHeadroom ?? null,
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

function clampBoundedInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseEnvIntInRange(raw: string | undefined, min: number, max: number): number | null {
  if (!raw || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min) return null;
  return clampBoundedInt(n, min, max);
}

function resolveConcurrencyField(
  override: number | null | undefined,
  envRaw: string | undefined,
  bounds: { min: number; max: number; defaultValue: number },
): { value: number; source: RuntimeConcurrencySource } {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return { value: clampBoundedInt(override, bounds.min, bounds.max), source: 'policy' };
  }
  const fromEnv = parseEnvIntInRange(envRaw, bounds.min, bounds.max);
  if (fromEnv !== null) {
    return { value: fromEnv, source: 'env' };
  }
  return { value: bounds.defaultValue, source: 'default' };
}

// Enforces llmInteractiveHeadroom < llmUserConcurrency so batch concurrency never starves to 0.
export function resolveEffectiveRuntimeConcurrency(
  policy: Partial<RuntimeConcurrencyOverrides> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): EffectiveRuntimeConcurrency {
  const tc = resolveConcurrencyField(
    policy?.transcriptionConcurrency,
    env.TRANSCRIPTION_CONCURRENCY,
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionConcurrency,
  );
  const tcc = resolveConcurrencyField(
    policy?.transcriptionChunkConcurrency,
    env.TRANSCRIPTION_CHUNK_CONCURRENCY,
    RUNTIME_CONCURRENCY_BOUNDS.transcriptionChunkConcurrency,
  );
  const luc = resolveConcurrencyField(
    policy?.llmUserConcurrency,
    env.LLM_USER_CONCURRENCY,
    RUNTIME_CONCURRENCY_BOUNDS.llmUserConcurrency,
  );
  const lih = resolveConcurrencyField(
    policy?.llmInteractiveHeadroom,
    env.LLM_INTERACTIVE_HEADROOM,
    RUNTIME_CONCURRENCY_BOUNDS.llmInteractiveHeadroom,
  );

  const safeHeadroom = Math.min(lih.value, Math.max(0, luc.value - 1));
  const effective: RuntimeConcurrencyValues = {
    transcriptionConcurrency: tc.value,
    transcriptionChunkConcurrency: tcc.value,
    llmUserConcurrency: luc.value,
    llmInteractiveHeadroom: safeHeadroom,
  };

  return {
    effective,
    overrides: {
      transcriptionConcurrency: policy?.transcriptionConcurrency ?? null,
      transcriptionChunkConcurrency: policy?.transcriptionChunkConcurrency ?? null,
      llmUserConcurrency: policy?.llmUserConcurrency ?? null,
      llmInteractiveHeadroom: policy?.llmInteractiveHeadroom ?? null,
    },
    sources: {
      transcriptionConcurrency: tc.source,
      transcriptionChunkConcurrency: tcc.source,
      llmUserConcurrency: luc.source,
      llmInteractiveHeadroom: lih.source,
    },
    batchLimit: Math.max(1, effective.llmUserConcurrency - effective.llmInteractiveHeadroom),
  };
}

export async function getEffectiveRuntimeConcurrency(): Promise<EffectiveRuntimeConcurrency> {
  const policy = await getGatewayPolicy();
  return resolveEffectiveRuntimeConcurrency(policy);
}

export function invalidateGatewayPolicyCache(): void {
  policyCache = null;
  policyFailUntil = 0;
  blockedIpsCache = null;
  blockedIpsFailUntil = 0;
}

export async function isEmergencyReadOnly(): Promise<boolean> {
  return (await getGatewayPolicy()).emergencyReadOnly;
}

let blockedIpsCache: { value: Set<string>; at: number } | null = null;
let blockedIpsFailUntil = 0;
const BLOCKED_IPS_TTL_MS = 15_000;
const BLOCKED_IPS_FAIL_BACKOFF_MS = 5_000;

// Strip IPv4-mapped IPv6 prefixes and ports to prevent IP blocklist bypasses.
export function normalizeIpAddress(rawIp: string): string {
  if (!rawIp || typeof rawIp !== 'string') return '';
  let ip = rawIp.trim();
  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip.startsWith('[') && ip.includes(']')) {
    const end = ip.indexOf(']');
    ip = ip.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
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

export function getBlockedIpEntries() {
  return prisma.gatewayBlockedIp.findMany({ orderBy: { createdAt: 'desc' } });
}

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

export function recordGatewaySecurityEvent(evt: SecurityEventInput): void {
  const key = `${evt.kind}:${evt.ipAddress ?? '-'}`;
  const now = Date.now();
  if (now - (eventThrottle.get(key) ?? 0) < EVENT_THROTTLE_MS) return;
  eventThrottle.set(key, now);
  if (eventThrottle.size > EVENT_THROTTLE_MAP_CAP) {
    // Evict oldest half on Map insertion order to cap throttle state under flood attacks.
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
    .catch(ignoreBestEffort);
}

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
  eventCounts24h: Array<{ kind: string; count: number }>;
  totalInterceptions24h: number;
  mcpFleetSummary: {
    totalFleet: number;
    activeFleet: number;
    pausedFleet: number;
    totalCalls: number;
  };
  mcpActiveSessions5m: number;
}
