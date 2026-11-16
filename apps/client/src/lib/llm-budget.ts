import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';
import { LLM_BUDGET_CACHE_TTL_MS, LLM_BUDGET_CACHE_MAX_ENTRIES } from '@/lib/constants';

/**
 * ─────────────────────────────────────────────────────────────
 * LLM 平台预算熔断（Phase 2 #7）。
 *
 * 口径：keyOrigin='platform' 的 TokenUsageLog 当日（服务器时区零点起）合计。
 * BYOK（keyOrigin='user'）烧用户自有 key，永久豁免。
 *
 * - 三层阈值：per-user 日上限 + platform 全局日上限 + source 分桶日上限（sourceQuotas），
 *   任一超限即熔断。分桶实现通道隔离：恶意刷某一通道只烧干自己桶内额度，
 *   不拖垮其他平台 key 职责（未配桶的 source 仅受全局约束，向后兼容）。
 * - 降级语义：转录类调用方捕获后延后入队；交互类(chat/scout/quiz)映射 429 友好提示
 * - 热调：PlatformBudgetConfig 单行表由 admin API 实时更新，进程内 30s 记忆刷新
 * - 异常类型 BudgetExceededError 为跨模块契约（transcription-queue 捕获延后任务）
 * ─────────────────────────────────────────────────────────────
 */

export class BudgetExceededError extends Error {
  constructor(public scope: 'user' | 'platform' | 'source', public source?: string) {
    super(`LLM budget exceeded (${scope}${source ? `:${source}` : ''})`);
    this.name = 'BudgetExceededError';
  }
}

/** source → 当日 token 上限；值为 0 表示该通道当日封禁 */
export type SourceQuotas = Record<string, number>;

interface BudgetConfigSnapshot {
  perUserDailyTokens: number;
  platformDailyTokens: number;
  breakerEnabled: boolean;
  sourceQuotas: SourceQuotas;
}

/** 归一 DB 里的 JSONB 为合法分桶表（非法条目丢弃：非字符串键/负值/非有限数） */
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

/** 读取预算配置（30s 进程内记忆；admin 更新后最迟 30s 全节点生效） */
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

/** admin 热调入口：写库并立即刷新本进程缓存 */
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

/** 当日水位快照（admin 可视）：全局 + 已配桶通道的分项消耗 */
export async function getBudgetStatus() {
  const cfg = await getBudgetConfig();
  const platformSpent = await spentTokens(null);
  const sourceKeys = Object.keys(cfg.sourceQuotas);
  const sourceSpendList = await Promise.all(sourceKeys.map((s) => spentTokens(null, s)));
  const sourceSpent = Object.fromEntries(sourceKeys.map((s, i) => [s, sourceSpendList[i]]));
  return { ...cfg, platformSpentToday: platformSpent, sourceSpentToday: sourceSpent };
}

/**
 * 预算门禁放行决策缓存（30s TTL，1024 容量）：
 * 在配额安全区间内避免同一用户每个切片反复执行 TokenUsageLog 聚合查询。
 */
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
  /** 记账 source（TokenUsageLog.source）：配了分桶配额时按通道隔离熔断 */
  source?: string;
}): Promise<void> {
  if (opts.keyOrigin === 'user') return; // BYOK 豁免
  const cfg = await getBudgetConfig();
  if (!cfg.breakerEnabled) return;
  if (cfg.platformDailyTokens <= 0 && cfg.perUserDailyTokens <= 0 && Object.keys(cfg.sourceQuotas).length === 0) return; // 全不设限

  const cacheKey = `${opts.userId ?? ''}:${opts.source ?? ''}`;
  if (budgetAllowCache.get(cacheKey) === true) return; // 缓存放行决策可复用
  // 拒绝决策不缓存——阈值热调后需即时恢复

  if (opts.userId && cfg.perUserDailyTokens > 0) {
    const userSpent = await spentTokens(opts.userId);
    if (userSpent >= cfg.perUserDailyTokens) {
      // 不写缓存：拒绝决策永不复用（阈值热调后即时恢复）
      throw new BudgetExceededError('user');
    }
  }
  if (cfg.platformDailyTokens > 0) {
    const total = await spentTokens(null);
    if (total >= cfg.platformDailyTokens) {
      throw new BudgetExceededError('platform');
    }
  }
  // 通道隔离：该 source 配了分桶时，只看本通道当日消耗（全局闸在上面已查）
  const sourceQuota = opts.source ? cfg.sourceQuotas[opts.source] : undefined;
  if (opts.source && sourceQuota !== undefined) {
    const sourceSpent = await spentTokens(null, opts.source);
    if (sourceSpent >= sourceQuota) {
      throw new BudgetExceededError('source', opts.source);
    }
  }
  budgetAllowCache.set(cacheKey, true);
}
