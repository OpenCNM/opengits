/**
 * ─────────────────────────────────────────────────────────────
 * GitHub token 池（Phase 3 #1）：多 PAT 轮询 + 头感知熔断。
 *
 * - 注册源：GITHUB_TOKENS（逗号分隔）∪ GITHUB_TOKEN（单 token 部署即池大小 1，
 *   行为与历史一致）；用户 OAuth 走 resolveGithubToken 独立轨道，不入池
 * - 健康度：remaining=0 或限流 403/429 → 冷却至 resetAt（无 reset 头默认 60s）；
 *   轮询选取仅在健康集合内进行；全部冷却时返回 undefined（调用方按匿名限流语义降级）
 * - 跨实例：冷却时必写 GithubQuotaLog（remaining=0 触发必记），其他实例经
 *   applyCrossInstanceCooldowns 吸收为本地冷却态——无需共享存储
 * - 指纹：sha256 前 12 位（原尾 4 位易撞车导致冷却归属错误）
 * ─────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';

export interface PoolToken {
  value: string;
  /** sha256 前 12 位指纹（埋点/日志辨识用，不泄露凭据） */
  fingerprint: string;
  cooldownUntil: number;
}

/** 指纹公式唯一入口：池注册、显式 token、埋点三方共用 */
export function tokenFingerprint(token: string): string {
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'anon';
}

let pool: PoolToken[] | null = null;
/** 轮询游标 */
let cursor = 0;
/** env 签名：变化即重建（配置热更新语义，测试友好） */
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

/**
 * 跨实例冷却吸收（T6.4）：读取各 token 最新一条 remaining=0 的配额日志，
 * 仍在冷却窗内的合并为本地冷却态。多实例无需共享存储——冷却本就会写日志
 * （remaining=0 触发必记），30s 节流防查询放大。失败 fail-open。
 */
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
    // DB 抖动：本实例独立观察兜底（原语义）
  }
}

/** 标记冷却（remaining=0/限流 403/429）；resetAtMs 缺省冷却 60s */

const quarantined = new Set<string>();

// 容量硬顶：用户 BYOK/OAuth token 401 指纹也会进本集合（按用户数累积，
// 对池无意义）。超顶按插入序淘汰最旧——淘汰只是让旧死 token 重试一次
// 再被隔离，fail-safe 方向
const QUARANTINED_MAX = 4096;

/** 标记 401 凭据失效隔离（进程内存级） */
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

/**
 * 从健康集合轮询选取一个 token。跳过已隔离(401)与冷却中 token。全部不可用 → undefined。
 */
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
  return undefined; // 全部冷却或已隔离
}

/** 标记冷却（remaining=0/403/429）；resetAtMs 缺省冷却 60s */
export function markTokenCooldown(fingerprint: string, resetAtMs?: number, now = Date.now()): void {
  const t = getPool().find((x) => x.fingerprint === fingerprint);
  if (!t) return;
  t.cooldownUntil = Math.max(t.cooldownUntil, resetAtMs && resetAtMs > now ? resetAtMs : now + 60_000);
}

/** 观测：池大小 / 当前健康数 / 隔离数 */
export function poolStats(now = Date.now()): { size: number; healthy: number; quarantined: number } {
  const tokens = getPool();
  return {
    size: tokens.length,
    healthy: tokens.filter((t) => !quarantined.has(t.fingerprint) && t.cooldownUntil <= now).length,
    quarantined: tokens.filter((t) => quarantined.has(t.fingerprint)).length,
  };
}

/** 测试注入：替换整个池 */
export function __setPoolForTests(tokens: Array<{ value: string }> | null): void {
  pool = tokens ? tokens.map((t) => ({ value: t.value, fingerprint: tokenFingerprint(t.value), cooldownUntil: 0 })) : null;
  envSignature = `${process.env.GITHUB_TOKENS ?? ''}|${process.env.GITHUB_TOKEN ?? ''}`;
  quarantined.clear();
  cursor = 0;
}
