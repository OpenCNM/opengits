import { createHash } from 'node:crypto';
import { ignoreBestEffort } from '../best-effort';

export interface PoolToken {
  value: string;
  fingerprint: string;
  cooldownUntil: number;
}

// Stable non-reversible key so telemetry and cooldown logs never expose raw PATs.
export function tokenFingerprint(token: string): string {
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'anon';
}

let pool: PoolToken[] | null = null;
let cursor = 0;
let envSignature = '';

function buildPool(): PoolToken[] {
  const raw = [
    ...(process.env.GITHUB_TOKENS || '').split(',').map((t) => t.trim()),
    (process.env.GITHUB_TOKEN || '').trim(),
  ].filter((t) => t.length > 0);
  const seen = new Set<string>();
  return raw
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
    .map((value) => ({ value, fingerprint: tokenFingerprint(value), cooldownUntil: 0 }));
}

function getPool(): PoolToken[] {
  const sig = `${process.env.GITHUB_TOKENS ?? ''}|${process.env.GITHUB_TOKEN ?? ''}`;
  if (!pool || sig !== envSignature) {
    pool = buildPool();
    envSignature = sig;
    cursor = 0;
  }
  return pool;
}

let crossRefreshedAt = 0;
const CROSS_REFRESH_INTERVAL_MS = 30_000;

// Merge remote cooldown state lazily so rate-limited PATs stay rested across worker replicas.
export async function applyCrossInstanceCooldowns(now = Date.now()): Promise<void> {
  if (now - crossRefreshedAt < CROSS_REFRESH_INTERVAL_MS) return;
  crossRefreshedAt = now;
  try {
    const { prisma } = await import('@/lib/db');
    const rows = await prisma.$queryRaw<Array<{ fingerprint: string; resetAt: Date | null }>>`
      SELECT DISTINCT ON ("fingerprint") "fingerprint", "resetAt"
      FROM "GithubQuotaLog"
      WHERE "remaining" = 0 AND "resetAt" IS NOT NULL
      ORDER BY "fingerprint", "createdAt" DESC`;
    for (const r of rows) {
      const until = r.resetAt ? new Date(r.resetAt).getTime() : 0;
      if (until > now) markTokenCooldown(r.fingerprint, until, now);
    }
  } catch {
    ignoreBestEffort();
  }
}

const quarantined = new Set<string>();

// Bound quarantine set so revoked user tokens cannot leak memory in long-lived workers.
const QUARANTINED_MAX = 4096;

export function markTokenQuarantined(fingerprint: string): void {
  if (!fingerprint || fingerprint === 'anon') return;
  quarantined.add(fingerprint);
  if (quarantined.size > QUARANTINED_MAX) {
    const oldest = quarantined.values().next().value;
    if (oldest !== undefined && oldest !== fingerprint) quarantined.delete(oldest);
  }
  console.warn(`[GithubTokenPool] token …${fingerprint} quarantined due to 401 Unauthorized`);
}

export function isTokenQuarantined(fingerprint: string): boolean {
  return quarantined.has(fingerprint);
}

export function clearQuarantinedForTests(): void {
  quarantined.clear();
}

export function acquirePoolToken(now = Date.now()): PoolToken | undefined {
  const tokens = getPool();
  if (tokens.length === 0) return undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[(cursor + i) % tokens.length];
    if (!quarantined.has(t.fingerprint) && t.cooldownUntil <= now) {
      cursor = (cursor + i + 1) % tokens.length;
      return t;
    }
  }
  return undefined;
}

export function markTokenCooldown(fingerprint: string, resetAtMs?: number, now = Date.now()): void {
  const t = getPool().find((x) => x.fingerprint === fingerprint);
  if (!t) return;
  t.cooldownUntil = Math.max(t.cooldownUntil, resetAtMs && resetAtMs > now ? resetAtMs : now + 60_000);
}

export function poolStats(now = Date.now()): { size: number; healthy: number; quarantined: number } {
  const tokens = getPool();
  return {
    size: tokens.length,
    healthy: tokens.filter((t) => !quarantined.has(t.fingerprint) && t.cooldownUntil <= now).length,
    quarantined: tokens.filter((t) => quarantined.has(t.fingerprint)).length,
  };
}

export function __setPoolForTests(tokens: Array<{ value: string }> | null): void {
  pool = tokens ? tokens.map((t) => ({ value: t.value, fingerprint: tokenFingerprint(t.value), cooldownUntil: 0 })) : null;
  envSignature = `${process.env.GITHUB_TOKENS ?? ''}|${process.env.GITHUB_TOKEN ?? ''}`;
  quarantined.clear();
  cursor = 0;
}
