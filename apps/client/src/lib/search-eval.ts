import goldenCasesJson from '../fixtures/search-eval-cases.json';

/**
 * ─────────────────────────────────────────────────────────────
 * 检索评测口径（Phase 3 #4）：切流决策的唯一依据。
 *
 * 判定规则（确定性、无人工标注）：
 * - 某 case 通过 = top-k 结果中存在「同时包含全部 expectKeywords」的 chunk
 *   （content/heading/title 子串、大小写不敏感）
 * - recall@k = 通过 case 数 / 总 case 数
 * - 降级分布按结果行特征分类：fts_rank>0 → FTS；match_count → 关键词兜底；
 *   其余 → ILIKE/trigram
 *
 * runner 由调用方注入（PG 引擎 / Meilisearch 适配器 / 双跑对比共用同一口径）。
 * ─────────────────────────────────────────────────────────────
 */

export interface SearchEvalCase {
  id: string;
  query: string;
  expectKeywords: string[];
}

export const GOLDEN_SEARCH_CASES: SearchEvalCase[] = goldenCasesJson as SearchEvalCase[];

export interface EvalRunnerResult {
  content?: string | null;
  heading?: string | null;
  title?: string | null;
  /** 降级路径分类（camelCase 为主——PG runner 的 ChunkSearchResult 真实输出形状） */
  ftsRank?: number | null;
  matchCount?: number | null;
  /** 兼容历史 snake_case runner 输出（外部适配器/mock） */
  fts_rank?: number | null;
  match_count?: number | null;
}

export type EvalEngineRunner = (
  repositoryId: string,
  query: string,
  k: number
) => Promise<EvalRunnerResult[]>;

export interface CaseReport {
  id: string;
  query: string;
  passed: boolean;
  latencyMs: number;
  /** FTS | keyword | ilike | empty */
  degradation: 'FTS' | 'keyword' | 'ilike' | 'empty';
  hitIndex: number;
}

export interface EngineEvalReport {
  engine: string;
  repositoryId: string;
  k: number;
  totalCases: number;
  passedCases: number;
  recallAtK: number;
  p50Ms: number;
  p95Ms: number;
  degradation: Record<string, number>;
  cases: CaseReport[];
}

function haystackOf(r: EvalRunnerResult): string {
  return `${r.content ?? ''}\n${r.heading ?? ''}\n${r.title ?? ''}`.toLowerCase();
}

function classifyDegradation(r: EvalRunnerResult): CaseReport['degradation'] {
  // 字段兼容 camelCase（PG runner 真实形状）与历史 snake_case（mock/外部 runner）
  const ftsRank = Number(r.ftsRank ?? r.fts_rank ?? 0);
  if (ftsRank > 0) return 'FTS';
  if (r.matchCount != null || r.match_count != null) return 'keyword';
  return r.content ? 'ilike' : 'empty';
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return Math.max(0, Math.round(sortedAsc[Math.max(0, idx)]));
}

/** 对单引擎执行完整黄金集评测 */
export async function evaluateEngine(
  engine: string,
  runner: EvalEngineRunner,
  repositoryId: string,
  opts: { k?: number; cases?: SearchEvalCase[] } = {}
): Promise<EngineEvalReport> {
  const k = opts.k ?? 5;
  const cases = opts.cases ?? GOLDEN_SEARCH_CASES;
  const reports: CaseReport[] = [];

  for (const c of cases) {
    const t0 = Date.now();
    let results: EvalRunnerResult[] = [];
    let degradation: CaseReport['degradation'] = 'empty';
    try {
      results = await runner(repositoryId, c.query, k);
    } catch {
      results = [];
    }
    const lat = Date.now() - t0;

    const keywords = c.expectKeywords.map((kw) => kw.toLowerCase());
    let hitIndex = -1;
    for (let i = 0; i < results.length; i++) {
      const hay = haystackOf(results[i]);
      if (keywords.every((kw) => hay.includes(kw))) {
        hitIndex = i;
        break;
      }
    }
    if (results.length > 0 && hitIndex >= 0) degradation = classifyDegradation(results[hitIndex]);
    else if (results.length > 0) degradation = classifyDegradation(results[0]);

    reports.push({
      id: c.id,
      query: c.query,
      passed: hitIndex >= 0,
      latencyMs: lat,
      degradation,
      hitIndex,
    });
  }

  const latencies = reports.map((r) => r.latencyMs).sort((a, b) => a - b);
  const passedCases = reports.filter((r) => r.passed).length;
  const degradation = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.degradation] = (acc[r.degradation] ?? 0) + 1;
    return acc;
  }, {});

  return {
    engine,
    repositoryId,
    k,
    totalCases: cases.length,
    passedCases,
    recallAtK: cases.length > 0 ? Number((passedCases / cases.length).toFixed(3)) : 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    degradation,
    cases: reports,
  };
}
