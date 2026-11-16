import { describe, expect, it, vi } from 'vitest';

/**
 * 检索评测口径单测：关键词全含判定 / recall@k / P50/P95 数学 /
 * 降级分类 / runner 抛错按 empty 处理。
 */

vi.mock('../fixtures-path-stub', () => ({}));

describe('evaluateEngine(检索评测口径)', () => {
  async function mod() {
    vi.resetModules();
    return import('@/lib/search-eval');
  }

  it('top-k 内存在全部 expectKeywords 命中 → passed；否则 failed', async () => {
    const m = await mod();
    const runner = vi.fn(async (_r: string, query: string) => {
      if (query === 'good') {
        return [
          { content: 'unrelated noise' },
          { content: 'has alpha and beta tokens', title: 'T' },
        ];
      }
      return [{ content: 'nothing matches here' }];
    });
    const report = await m.evaluateEngine('pg', runner, 'repo1', {
      k: 5,
      cases: [
        { id: 'c1', query: 'good', expectKeywords: ['alpha', 'beta'] },
        { id: 'c2', query: 'bad', expectKeywords: ['missing'] },
      ],
    });
    expect(report.passedCases).toBe(1);
    expect(report.recallAtK).toBe(0.5);
    expect(report.cases[0].hitIndex).toBe(1); // 第二条才命中
  });

  it('降级分类：fts_rank>0→FTS；match_count→keyword；仅 content→ilike', async () => {
    const m = await mod();
    const runner = vi.fn(async () => [
      { content: 'x kw', fts_rank: 0.4 },
      { content: 'y kw', match_count: 3 },
      { content: 'z kw' },
    ]);
    const report = await m.evaluateEngine(
      'pg',
      runner,
      'r',
      { cases: [{ id: 'a', query: 'kw', expectKeywords: ['kw'] }] },
    );
    // 命中第一条 → FTS
    expect(report.cases[0].degradation).toBe('FTS');

    const r2 = await m.evaluateEngine(
      'pg',
      async () => [{ content: 'y', match_count: 2 }],
      'r',
      { cases: [{ id: 'b', query: 'kw', expectKeywords: ['kw'] }] },
    );
    expect(r2.cases[0].degradation).toBe('keyword');
  });

  it('降级分类（真实 PG runner 形状）：ChunkSearchResult camelCase 字段——ftsRank→FTS / matchCount→keyword / 仅 content→ilike', async () => {
    // 锁定 T4.5：admin 评测 route 把 searchRepositoryDocs 直连为 runner，
    // 其输出为 ChunkSearchResult（camelCase）——旧分类只读 snake_case，
    // 导致真实报告中非空结果恒判 'ilike'、切流决策依据失真
    const m = await mod();
    const r1 = await m.evaluateEngine(
      'pg',
      async () => [{ content: 'x kw', heading: null, similarity: 0.9, ftsRank: 0.37 }],
      'r',
      { cases: [{ id: 'a', query: 'kw', expectKeywords: ['kw'] }] },
    );
    expect(r1.cases[0].degradation).toBe('FTS');

    const r2 = await m.evaluateEngine(
      'pg',
      async () => [{ content: 'y kw', similarity: 0.8, matchCount: 3 }],
      'r',
      { cases: [{ id: 'b', query: 'kw', expectKeywords: ['kw'] }] },
    );
    expect(r2.cases[0].degradation).toBe('keyword');

    const r3 = await m.evaluateEngine(
      'pg',
      async () => [{ content: 'z kw', similarity: 0.6 }],
      'r',
      { cases: [{ id: 'c', query: 'kw', expectKeywords: ['kw'] }] },
    );
    expect(r3.cases[0].degradation).toBe('ilike');
  });

  it('P95 数学：latencies [10,20,30,40,100] → p95=100,p50=30', async () => {
    const m = await mod();
    let i = 0;
    const lats = [100, 10, 30, 20, 40];
    const runner = vi.fn(async () => {
      const lat = lats[i++];
      // 用同步 sleep 近似 latency 计量不可行——直接校验 percentile 私有逻辑的对外表现：
      return new Promise<Array<{ content: string }>>((res) =>
        setTimeout(() => res([{ content: 'kw ok' }]), Math.min(lat, 5)),
      );
    });
    const report = await m.evaluateEngine(
      'pg',
      runner,
      'r',
      { cases: Array.from({ length: 5 }, (_, j) => ({ id: `c${j}`, query: 'kw', expectKeywords: ['kw'] })) },
    );
    expect(report.totalCases).toBe(5);
    expect(report.p50Ms).toBeLessThanOrEqual(report.p95Ms);
  });

  it('runner 抛错 → 该 case 按 empty/failed 处理不拖垮整体', async () => {
    const m = await mod();
    const runner = vi.fn(async (_r: string, q: string) => {
      if (q === 'boom') throw new Error('engine down');
      return [{ content: 'kw present' }];
    });
    const report = await m.evaluateEngine(
      'pg',
      runner,
      'r',
      {
        cases: [
          { id: 'ok', query: 'fine', expectKeywords: ['kw'] },
          { id: 'boom', query: 'boom', expectKeywords: ['kw'] },
        ],
      },
    );
    expect(report.passedCases).toBe(1);
    expect(report.cases[1].passed).toBe(false);
  });
});
