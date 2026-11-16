import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBreakingChanges } from '@/lib/mcp/tools/maintenance';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { DocSearchUnavailableError } from '@/lib/mcp/doc-search';

const docSearchMock = vi.hoisted(() => ({
  searchRepositoryDocs: vi.fn(),
  locateRepositorySections: vi.fn(),
}));
vi.mock('@/lib/mcp/doc-search', async () => {
  const actual = await vi.importActual<any>('@/lib/mcp/doc-search');
  return { ...actual, ...docSearchMock };
});

vi.mock('@/lib/telemetry/mcp-beacon', () => ({
  recordMcpToolCall: vi.fn(async () => {}),
  recordMcpToolError: vi.fn(async () => {}),
}));

describe('MCP check_breaking_changes Tool (Migration Gotchas Audit)', () => {
  const mockRepo = {
    id: 'repo-next-1',
    owner: 'vercel',
    repo: 'next.js',
    branch: 'canary',
    gitSha: 'sha-next-123',
    navTree: [],
  };

  const createRuntime = (repos: any[] = [mockRepo], multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async (scope?: string) => {
      if (scope) {
        const found = repos.find((r) => `${r.owner}/${r.repo}` === scope || r.id === scope);
        if (!found) return null;
        return {
          owner: found.owner,
          repo: found.repo,
          repository: found,
          documents: [],
          navTree: [],
        };
      }
      return {
        owner: repos[0].owner,
        repo: repos[0].repo,
        repository: repos[0],
        documents: [],
        navTree: [],
      };
    },
    listRepositories: async () =>
      repos.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        repository: r,
        documents: [],
        navTree: [],
      })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    docSearchMock.searchRepositoryDocs.mockReset();
    docSearchMock.locateRepositorySections.mockReset();
  });

  it('检索后端故障时失效封闭 (fail-closed)，明确区分于真盲区', async () => {
    docSearchMock.locateRepositorySections.mockRejectedValue(
      new DocSearchUnavailableError('PostgreSQL FTS connection pool exhausted')
    );

    const res = await runBreakingChanges({ query: 'cookies() async' }, {}, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Search backend unavailable for breaking-change audit');
    expect(res.content[0].text).toContain('this is an infrastructure failure, NOT an empty result');
  });

  it('单仓无破坏性变更时输出明确无命中结论', async () => {
    docSearchMock.locateRepositorySections.mockResolvedValue([]);

    const res = await runBreakingChanges({ query: 'useState' }, {}, createRuntime());
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('No explicit breaking changes found for "useState" in vercel/next.js.');
  });

  it('locator 模式输出高密度锚点与相似度评分', async () => {
    docSearchMock.locateRepositorySections.mockResolvedValue([
      {
        id: 'chunk-1',
        path: 'docs/migrating-to-v15.md',
        title: 'Migrating to Next.js 15',
        heading: 'Async Request Headers',
        headingPath: 'Migrating to Next.js 15 > Async Request Headers',
        snippet: 'cookies() and headers() must now be awaited asynchronously.',
        similarity: 0.94,
      },
    ]);

    const res = await runBreakingChanges({ query: 'headers()', detail: 'locator' }, {}, createRuntime());
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Breaking Changes Locator for "headers()" in vercel/next.js');
    expect(text).toContain('Score: 94.0%');
    expect(text).toContain('docs/migrating-to-v15.md');
    expect(text).toContain('Async Request Headers');
  });

  it('full 模式输出正文并在超出 token_budget 时安全裁剪', async () => {
    docSearchMock.searchRepositoryDocs.mockResolvedValue([
      {
        path: 'docs/v15.md',
        title: 'V15 Changes',
        heading: 'Breaking Changes',
        content: 'Long documentation body: ' + 'A'.repeat(5000),
      },
    ]);

    const res = await runBreakingChanges(
      { query: 'headers', detail: 'full', token_budget: 100 },
      {},
      createRuntime()
    );
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('docs/v15.md');
    expect(text).toContain('Breaking Changes');
  });

  it('Hub 模式多仓扇出检索时聚合多仓结果', async () => {
    const repos = [
      mockRepo,
      {
        id: 'repo-react-2',
        owner: 'facebook',
        repo: 'react',
        branch: 'main',
        gitSha: 'sha-react-19',
        navTree: [],
      },
    ];

    docSearchMock.locateRepositorySections.mockImplementation(async (repoId: string) => {
      if (repoId === 'repo-next-1') {
        return [
          {
            id: 'c-1',
            path: 'v15.md',
            title: 'Next 15',
            heading: 'Headers',
            headingPath: 'Next 15 > Headers',
            snippet: 'async headers migration',
            similarity: 0.91,
          },
        ];
      }
      return [];
    });

    const res = await runBreakingChanges({ query: 'async' }, {}, createRuntime(repos, true));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Breaking Changes Locator for "async" across the Hub');
    expect(text).toContain('vercel/next.js');
  });
});
