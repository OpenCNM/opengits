import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFanoutDetailBlocks } from '@/lib/mcp/tools/shared';
import { searchRepositoryDocs } from '@/lib/mcp/doc-search';

vi.mock('@/lib/mcp/doc-search', () => ({
  searchRepositoryDocs: vi.fn(),
  rerankChunkResults: vi.fn((results: any[]) => results),
}));

const mkCtx = (id: string, owner: string, repo: string, editionLabel?: string) => ({
  owner,
  repo,
  repository: { id },
  targetVersionLabel: undefined,
  edition: '',
  editionLabel,
});

describe('Hub fan-out detail 两轮法（buildFanoutDetailBlocks）', () => {
  beforeEach(() => {
    vi.mocked(searchRepositoryDocs).mockReset();
  });

  it('按轮1最佳分取前 K 仓、预算均分并带 Source 归因', async () => {
    vi.mocked(searchRepositoryDocs).mockImplementation(async (repoId: string) =>
      repoId === 'repo-a'
        ? [{ id: 'c1', heading: 'H', headingPath: 'H', content: 'alpha content', title: 'A', path: 'a.md', similarity: 0.9 }]
        : [{ id: 'c2', heading: 'H2', headingPath: 'H2', content: 'beta content', title: 'B', path: 'b.md', similarity: 0.5 }]
    );

    const perRepoHits = [
      { ctx: mkCtx('repo-a', 'o1', 'r1', '深度剖析版'), hits: [{ id: 'h1', path: 'a.md', title: 'A', heading: null, headingPath: null, snippet: '', similarity: 0.9 }] },
      { ctx: mkCtx('repo-b', 'o2', 'r2'), hits: [{ id: 'h2', path: 'b.md', title: 'B', heading: null, headingPath: null, snippet: '', similarity: 0.5 }] },
      { ctx: mkCtx('repo-c', 'o3', 'r3'), hits: [] as any[] },
    ];

    const out = await buildFanoutDetailBlocks({
      perRepoHits,
      expandedQuery: 'q',
      rawQuery: 'q',
      detail: 'full',
      tokenBudget: 4000,
      userId: undefined,
      headerPrefix: 'Cross-Tutorial Search Results',
      hubLabel: 'your Hub',
      summaryMode: false,
    });

    expect(out).toBeTruthy();
    expect(out).toContain('Cross-Tutorial Search Results for "q" across your Hub [Full Mode] (top 2 tutorials):');
    expect(out).toContain('[Source: o1/r1 · 讲法: 深度剖析版]');
    expect(out).toContain('[Source: o2/r2]');
    expect(out).toContain('alpha content');
    // 预算均分：两仓各 2000
    expect(vi.mocked(searchRepositoryDocs).mock.calls[0][5]).toBe(2000);
  });

  it('全部仓零结果返回 null（回落轮1 locator）', async () => {
    vi.mocked(searchRepositoryDocs).mockResolvedValue([]);
    const perRepoHits = [
      { ctx: mkCtx('repo-a', 'o1', 'r1'), hits: [{ id: 'h1', path: 'a.md', title: 'A', heading: null, headingPath: null, snippet: '', similarity: 0.9 }] },
    ];
    const out = await buildFanoutDetailBlocks({
      perRepoHits,
      expandedQuery: 'q',
      rawQuery: 'q',
      detail: 'summary',
      tokenBudget: 4000,
      userId: undefined,
      headerPrefix: 'X',
      hubLabel: 'hub',
      summaryMode: true,
    });
    expect(out).toBeNull();
  });

  it('小预算保底 256/仓', async () => {
    vi.mocked(searchRepositoryDocs).mockResolvedValue([
      { id: 'c1', heading: null, headingPath: null, content: 'x', title: 'T', path: 'p.md', similarity: 0.5 },
    ]);
    const perRepoHits = [
      { ctx: mkCtx('repo-a', 'o1', 'r1'), hits: [{ id: 'h1', path: 'a.md', title: 'A', heading: null, headingPath: null, snippet: '', similarity: 0.9 }] },
    ];
    await buildFanoutDetailBlocks({
      perRepoHits,
      expandedQuery: 'q',
      rawQuery: 'q',
      detail: 'full',
      tokenBudget: 100,
      userId: undefined,
      headerPrefix: 'X',
      hubLabel: 'hub',
      summaryMode: false,
    });
    expect(vi.mocked(searchRepositoryDocs).mock.calls[0][5]).toBe(256);
  });
});
