import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSearch, expandSearchQuery } from '@/lib/mcp/tools/search';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { DocSearchUnavailableError } from '@/lib/mcp/doc-search';

const prismaMock = vi.hoisted(() => ({
  globalConcept: {
    findMany: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const docSearchMock = vi.hoisted(() => ({
  searchRepositoryDocs: vi.fn(),
  locateRepositorySections: vi.fn(),
  injectConceptDependencyHint: vi.fn(async () => ''),
  injectConceptEnrichments: vi.fn(async (_repoId, _query, text) => text),
  rerankChunkResults: vi.fn((results) => results),
}));
vi.mock('@/lib/mcp/doc-search', async () => {
  const actual = await vi.importActual<any>('@/lib/mcp/doc-search');
  return {
    ...actual,
    ...docSearchMock,
  };
});

vi.mock('@/lib/telemetry/mcp-beacon', () => ({
  recordMcpToolCall: vi.fn(async () => {}),
  recordMcpToolError: vi.fn(async () => {}),
}));

describe('MCP search Unified Tool (Query Expansion, Dimensions & Fail-Closed)', () => {
  const mockRepoA = {
    id: 'repo-next-1',
    owner: 'vercel',
    repo: 'next.js',
    branch: 'canary',
    gitSha: 'sha-next-001',
    navTree: [],
    documents: [],
  };

  const mockRepoB = {
    id: 'repo-react-2',
    owner: 'facebook',
    repo: 'react',
    branch: 'main',
    gitSha: 'sha-react-002',
    navTree: [],
    documents: [],
  };

  const createRuntime = (repos: any[] = [mockRepoA], multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async (scope?: string) => {
      if (scope) {
        const found = repos.find((r) => `${r.owner}/${r.repo}` === scope || r.id === scope);
        return found
          ? { owner: found.owner, repo: found.repo, repository: found, documents: [], navTree: [] }
          : null;
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
    prismaMock.globalConcept.findMany.mockReset().mockResolvedValue([]);
    docSearchMock.searchRepositoryDocs.mockReset().mockResolvedValue([]);
    docSearchMock.locateRepositorySections.mockReset().mockResolvedValue([]);
    docSearchMock.injectConceptDependencyHint.mockReset().mockResolvedValue('');
    docSearchMock.injectConceptEnrichments.mockReset().mockImplementation(async (_r, _q, t) => t);
    docSearchMock.rerankChunkResults.mockReset().mockImplementation((r) => r);
  });

  describe('expandSearchQuery (受控 CJK / 别名查询扩展)', () => {
    it('空查询与非字符串入参安全返回空对象', async () => {
      const res = await expandSearchQuery('');
      expect(res.keywords).toEqual([]);
      expect(res.aliasSources).toEqual([]);
    });

    it('提取 CJK 宽字符与英文字符', async () => {
      const res = await expandSearchQuery('App Router 动态路由');
      expect(res.keywords).toContain('App');
      expect(res.keywords).toContain('Router');
      expect(res.keywords).toContain('动态路由');
    });

    it('命中 GlobalConcept 时并入别名并标注归因', async () => {
      prismaMock.globalConcept.findMany.mockResolvedValue([
        { canonicalName: 'App Router', aliases: ['app directory', 'RSC routing'] },
      ]);

      const res = await expandSearchQuery('App Router');
      expect(res.keywords).toContain('App Router');
      expect(res.keywords).toContain('app directory');
      expect(res.keywords).toContain('RSC routing');
      expect(res.aliasSources).toContain('"App Router"');
    });
  });

  describe('runSearch 单仓精搜 (Single Repo Mode)', () => {
    it('detail="locator" 时返回章节 Address 与 Snippet，不拉取海量 Chunk', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([
        {
          path: 'docs/routing.mdx',
          title: 'Routing Guide',
          heading: 'Dynamic Routes',
          headingPath: 'Routing > Dynamic Routes',
          similarity: 0.92,
          snippet: 'Use [param] folder syntax for dynamic params.',
        },
      ]);

      const res = await runSearch({ query: 'dynamic routes', detail: 'locator' }, {}, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Search Results for "dynamic routes" across vercel/next.js');
      expect(text).toContain('Address: docs/routing.mdx#Routing > Dynamic Routes');
      expect(text).toContain('Snippet: Use [param] folder syntax');
      expect(docSearchMock.locateRepositorySections).toHaveBeenCalled();
      expect(docSearchMock.searchRepositoryDocs).not.toHaveBeenCalled();
    });

    it('detail="summary" 时拉取正文并进行摘要', async () => {
      docSearchMock.searchRepositoryDocs.mockResolvedValue([
        {
          path: 'docs/routing.mdx',
          title: 'Routing Guide',
          heading: 'Dynamic Routes',
          headingPath: 'Routing > Dynamic Routes',
          similarity: 0.95,
          content: 'Dynamic routes enable dynamic segments in URLs...',
        },
      ]);

      const res = await runSearch({ query: 'dynamic routes', detail: 'summary' }, {}, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Search Results for "dynamic routes" across vercel/next.js');
      expect(text).toContain('Dynamic routes enable dynamic segments');
      expect(docSearchMock.searchRepositoryDocs).toHaveBeenCalled();
    });

    it('检索无结果时返回友好的无结果提示', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([]);
      const res = await runSearch({ query: 'nonexistent keyword' }, {}, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('No relevant documentation chunks found for query: "nonexistent keyword" in vercel/next.js');
    });
  });

  describe('runSearch 作用域与 Hub 跨仓扇出 (Multi-Repo Fan-Out)', () => {
    it('mode="gotchas" 时自动委托给破坏性变更检索', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([
        {
          path: 'docs/migration.mdx',
          title: 'Migration',
          heading: 'Breaking in v15',
          headingPath: 'Migration > Breaking in v15',
          similarity: 0.98,
          snippet: 'cookies() is now async in Next.js 15',
        },
      ]);

      const res = await runSearch({ query: 'cookies', mode: 'gotchas' }, {}, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Breaking Changes Locator for "cookies" in vercel/next.js');
      expect(text).toContain('cookies() is now async in Next.js 15');
    });

    it('Hub 模式未传 repository 时跨书架并发检索并合并排序', async () => {
      docSearchMock.locateRepositorySections.mockImplementation(async (repoId: string) => {
        if (repoId === 'repo-next-1') {
          return [
            {
              path: 'docs/server-components.mdx',
              title: 'Server Components',
              heading: 'RSC Intro',
              similarity: 0.88,
              snippet: 'RSC in Next.js',
            },
          ];
        }
        return [
          {
            path: 'docs/rsc-spec.mdx',
            title: 'React Server Components',
            heading: 'Spec',
            similarity: 0.95,
            snippet: 'React RSC Core Spec',
          },
        ];
      });

      const res = await runSearch({ query: 'RSC' }, {}, createRuntime([mockRepoA, mockRepoB], true));
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Cross-Tutorial Search Results for "RSC" across the Hub');
      expect(text).toContain('[Source: facebook/react]');
      expect(text).toContain('[Source: vercel/next.js]');
    });

    it('Hub 模式书架为空时返回 emptyHubError', async () => {
      const emptyRuntime = createRuntime([], true);
      const res = await runSearch({ query: 'RSC' }, {}, emptyRuntime);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('the Hub is empty');
    });
  });

  describe('Fail-Closed 故障断路器 (DocSearchUnavailableError)', () => {
    it('底层向量/检索服务宕机时返回显式 isError，严禁伪装为零结果', async () => {
      docSearchMock.locateRepositorySections.mockRejectedValue(
        new DocSearchUnavailableError('Postgres vector extension connection timeout')
      );

      const res = await runSearch({ query: 'Server Actions' }, {}, createRuntime());
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      expect(text).toContain('Error: Search backend unavailable for "Server Actions" — this is an infrastructure failure, NOT an empty result.');
    });
  });
});
