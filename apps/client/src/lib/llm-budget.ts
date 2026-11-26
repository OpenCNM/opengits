import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';
import { LLM_BUDGET_CACHE_TTL_MS, LLM_BUDGET_CACHE_MAX_ENTRIES } from '@/lib/constants';

// Platform key quotas fuse per-user, global, and per-source buckets; BYOK (user key) calls are exempt.

export class BudgetExceededError extends Error {
  constructor(public scope: 'user' | 'platform' | 'source', public source?: string) {
    super(`LLM budget exceeded (${scope}${source ? `:${source}` : ''})`);
    this.name = 'BudgetExceededError';
  }
}

export type SourceQuotas = Record<string, number>;

interface BudgetConfigSnapshot {
  perUserDailyTokens: number;
  platformDailyTokens: number;
  breakerEnabled: boolean;
  sourceQuotas: SourceQuotas;
}

export function normalizeSourceQuotas(raw: unknown): SourceQuotas {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SourceQuotas = {};
  for (const [source, limit] of Object.entries(raw as Record<string, unknown>)) {
    if (source === '__proto__' || source === 'constructor' || source === 'prototype') continue;
    if (typeof source !== 'string' || source.trim().length === 0 || source.length > 128) continue;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      out[source.trim()] = Math.floor(limit);
    }
  }
  return out;
}

let configCache: { value: BudgetConfigSnapshot; at: number } | null = null;
const CONFIG_TTL_MS = 30_000;

export async function getBudgetConfig(): Promise<BudgetConfigSnapshot> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  let row = await prisma.platformBudgetConfig.findUnique({ where: { id: 'singleton' } });
  if (!row) {
    try {
      row = await prisma.platformBudgetConfig.create({ data: { id: 'singleton' } });
    } catch {
      row = (await prisma.platformBudgetConfig.findUnique({ where: { id: 'singleton' } }))!;
    }
  }
  const value: BudgetConfigSnapshot = {
    perUserDailyTokens: row.perUserDailyTokens,
    platformDailyTokens: row.platformDailyTokens,
    breakerEnabled: row.breakerEnabled,
    sourceQuotas: normalizeSourceQuotas(row.sourceQuotas),
  };
  configCache = { value, at: Date.now() };
  return value;
}

export async function updateBudgetConfig(patch: Partial<BudgetConfigSnapshot>): Promise<BudgetConfigSnapshot> {
  const row = await prisma.platformBudgetConfig.upsert({
    where: { id: 'singleton' },
    update: patch,
    create: { id: 'singleton', ...patch },
  });
  configCache = {
    value: {
      perUserDailyTokens: row.perUserDailyTokens,
      platformDailyTokens: row.platformDailyTokens,
      breakerEnabled: row.breakerEnabled,
      sourceQuotas: normalizeSourceQuotas(row.sourceQuotas),
    },
    at: Date.now(),
  };
  invalidateBudgetCache();
  return configCache.value;
}

function dayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function spentTokens(userId?: string | null, source?: string): Promise<number> {
  const agg = await prisma.tokenUsageLog.aggregate({
    where: {
      keyOrigin: 'platform',
      createdAt: { gte: dayStart() },
      ...(userId ? { userId } : {}),
      ...(source ? { source } : {}),
    },
    _sum: { totalTokens: true },
  });
  return agg._sum.totalTokens ?? 0;
}

export async function getBudgetStatus() {
  const cfg = await getBudgetConfig();
  const platformSpent = await spentTokens(null);
  const sourceKeys = Object.keys(cfg.sourceQuotas);
  const sourceSpendList = await Promise.all(sourceKeys.map((s) => spentTokens(null, s)));
  const sourceSpent = Object.fromEntries(sourceKeys.map((s, i) => [s, sourceSpendList[i]]));
  return { ...cfg, platformSpentToday: platformSpent, sourceSpentToday: sourceSpent };
}

const budgetAllowCache = new TtlCache<boolean>(
  LLM_BUDGET_CACHE_TTL_MS,
  LLM_BUDGET_CACHE_MAX_ENTRIES
);

export function invalidateBudgetCache(): void {
  budgetAllowCache.clear();
}

export async function checkLlmBudget(opts: {
  userId?: string | null;
  keyOrigin?: 'platform' | 'user';
  source?: string;
}): Promise<void> {
  if (opts.keyOrigin === 'user') return;
  const cfg = await getBudgetConfig();
  if (!cfg.breakerEnabled) return;
  if (cfg.platformDailyTokens <= 0 && cfg.perUserDailyTokens <= 0 && Object.keys(cfg.sourceQuotas).length === 0) return;

  const cacheKey = `${opts.userId ?? ''}:${opts.source ?? ''}`;
  if (budgetAllowCache.get(cacheKey) === true) return;
  // Never cache denials so admin threshold increases take effect immediately.

  if (opts.userId && cfg.perUserDailyTokens > 0) {
    const userSpent = await spentTokens(opts.userId);
    if (userSpent >= cfg.perUserDailyTokens) {
      throw new BudgetExceededError('user');
    }
  }
  if (cfg.platformDailyTokens > 0) {
    const total = await spentTokens(null);
    if (total >= cfg.platformDailyTokens) {
      throw new BudgetExceededError('platform');
    }
  }
  const sourceQuota = opts.source ? cfg.sourceQuotas[opts.source] : undefined;
  if (opts.source && sourceQuota !== undefined) {
    const sourceSpent = await spentTokens(null, opts.source);
    if (sourceSpent >= sourceQuota) {
      throw new BudgetExceededError('source', opts.source);
    }
  }
  budgetAllowCache.set(cacheKey, true);
}
