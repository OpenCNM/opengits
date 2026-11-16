import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 2 快照基线：锁定高险工具的**完整输出字符串**。
 * 这是 Phase 3（ToolResult 渲染管线）的 byte 稳定安全网——管线化后
 * 每个快照必须逐字节不变（ envelope 语义不得漂移）。
 * 若有意变更输出格式：改实现 → `npx vitest run -u` 更新快照 → 评审 diff。
 */

// ── mock 面 ──
const readFileLocalMock = vi.fn(async () => null);
vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: (...args: unknown[]) => readFileLocalMock(...(args as [string, string, string, string])),
}));
const symbolsMock = vi.hoisted(() => ({
  executeSidecarSymbolLookup: vi.fn(),
  executeSidecarSymbolSearch: vi.fn(),
}));
vi.mock('@/engine/symbols-driver', () => symbolsMock);
const dissectMock = vi.hoisted(() => ({ executeSidecarDissectAst: vi.fn() }));
vi.mock('@/engine/dissect-driver', () => dissectMock);
const beacon = vi.hoisted(() => ({
  recordMcpToolCall: vi.fn(async () => {}),
  recordMcpToolError: vi.fn(async () => {}),
  wrapToolTelemetry: vi.fn((_base: unknown, handler: Function) => handler),
  runWithMcpClientContext: vi.fn((_c: unknown, fn: Function) => fn()),
  runWithMcpEditionContext: vi.fn((_e: unknown, fn: Function) => fn()),
}));
vi.mock('@/lib/telemetry/mcp-beacon', () => beacon);
const prismaMock = vi.hoisted(() => ({
  documentChunk: { findMany: vi.fn() },
  document: { findFirst: vi.fn() },
  tutorialConceptNode: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  tutorialConceptEdge: { count: vi.fn() },
  repository: { findMany: vi.fn() },
  chapterVersion: { findMany: vi.fn() },
  chapterQuiz: { findMany: vi.fn() },
  globalConcept: { findMany: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
const docSearchMock = vi.hoisted(() => ({
  searchRepositoryDocs: vi.fn(),
  locateRepositorySections: vi.fn(),
  rerankChunkResults: vi.fn((r: unknown[]) => r),
}));
vi.mock('@/lib/mcp/doc-search', async () => {
  const actual = await vi.importActual<any>('@/lib/mcp/doc-search');
  return { ...actual, ...docSearchMock };
});
vi.mock('@/lib/mcp/concept-graph', () => ({
  matchConceptNode: vi.fn(async () => null),
  getConceptDependencies: vi.fn(async () => []),
  formatDependencyHintText: vi.fn(() => ''),
  CONCEPT_DEPENDENCY_HINT_HEADER: '',
  getConceptGrounding: vi.fn(async () => null),
  resolveConceptNode: vi.fn(async () => null),
  getConceptNeighbors: vi.fn(),
  getLearningPathConcepts: vi.fn(),
  getConceptCodeContext: vi.fn(),
  formatLearningPathOutput: vi.fn(),
  formatNeighborsOutput: vi.fn(),
  buildGraphPositionText: vi.fn(async () => ''),
}));
vi.mock('@/lib/mcp/outline-projector', () => ({
  getEffectiveNavTree: vi.fn(async () => []),
}));

const mockRepo = {
  id: 'repo-1',
  owner: 'acme',
  repo: 'calculator',
  branch: 'main',
  gitSha: 'sha-abc',
  repoProfile: {},
  navTree: [],
  documents: [
    { id: 'doc-1', title: 'Getting Started', path: 'docs/getting-started.md', summary: 'Quick intro' },
  ],
};

function createRuntime(over: Record<string, unknown> = {}) {
  return {
    multiRepo: false,
    resolveRepository: async () => ({
      owner: 'acme',
      repo: 'calculator',
      repository: mockRepo,
      documents: mockRepo.documents,
      navTree: mockRepo.navTree,
      ...over,
    }),
  } as any;
}

const text = (res: any) => (res?.content?.[0]?.text ?? '') as string;

describe('Phase 2 快照基线（Phase 3 管线化前的 byte 锁）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileLocalMock.mockReset();
    readFileLocalMock.mockResolvedValue(null);
    prismaMock.document.findFirst.mockReset();
    prismaMock.documentChunk.findMany.mockReset();
    prismaMock.chapterVersion.findMany.mockReset();
    docSearchMock.locateRepositorySections.mockReset();
    docSearchMock.searchRepositoryDocs.mockReset();
    prismaMock.globalConcept.findMany.mockReset();
    prismaMock.globalConcept.findMany.mockResolvedValue([]);
  });

  describe('search（单仓 locator / summary / 空 / 回退）', () => {
    it('locator 命中输出', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([
        {
          id: 'c1', path: 'docs/a.md', title: 'A', heading: 'Install', headingPath: 'Install',
          snippet: 'run npm install to get started quickly', similarity: 0.87,
        },
      ]);
      const { runSearch } = await import('@/lib/mcp/tools/search');
      const res = await runSearch({ query: 'install' }, {}, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('summary 命中输出（导师卡片为空注入形态）', async () => {
      docSearchMock.searchRepositoryDocs.mockResolvedValue([
        {
          id: 'c1', heading: 'Install', headingPath: 'Install', content: 'Full body content about installation steps.',
          title: 'A', path: 'docs/a.md', similarity: 0.66,
        },
      ]);
      const { runSearch } = await import('@/lib/mcp/tools/search');
      const res = await runSearch({ query: 'install', detail: 'summary' }, {}, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('空结果输出', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([]);
      const { runSearch } = await import('@/lib/mcp/tools/search');
      const res = await runSearch({ query: 'nothing' }, {}, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('回退上下文头部警告注入', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([
        { id: 'c1', path: 'docs/a.md', title: 'A', heading: null, headingPath: null, snippet: 'x', similarity: 0.5 },
      ]);
      const { runSearch } = await import('@/lib/mcp/tools/search');
      const res = await runSearch({ query: 'x' }, {}, createRuntime({ isFallback: true, requestedEdition: 'ed_deep', edition: '', editionLabel: undefined }));
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('read（分节 / 版本归因 / 全文 / 未命中）', () => {
    it('分节命中（含 graphPos 空形态）', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([
        { heading: 'Install', headingPath: 'Install', content: 'Section body about installing.', semVerLabel: null },
      ]);
      const { runRead } = await import('@/lib/mcp/tools/read');
      const res = await runRead({ target: 'docs/getting-started.md#Install' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('版本归因行（chunk semVer 与目标不一致）', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([
        { heading: 'Install', headingPath: 'Install', content: 'Section body.', semVerLabel: 'v15.0.0' },
      ]);
      const { runRead } = await import('@/lib/mcp/tools/read');
      const res = await runRead({ target: 'docs/getting-started.md#Install' }, createRuntime({ targetVersionLabel: 'v16' }));
      expect(text(res)).toMatchSnapshot();
    });

    it('全文读取', async () => {
      prismaMock.document.findFirst.mockResolvedValue({
        content: '# Full doc\n\nBody line.\n',
        contentId: null,
        contentRef: null,
      });
      const { runRead } = await import('@/lib/mcp/tools/read');
      const res = await runRead({ target: 'docs/getting-started.md' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('文档未命中错误', async () => {
      const { runRead } = await import('@/lib/mcp/tools/read');
      const res = await runRead({ target: 'missing.md' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('read_symbol（三档 + 归档缺失降级）', () => {
    const detail = {
      name: 'add', kind: 'function', file: 'src/math/calc.ts',
      startLine: 3, endLine: 7, role: 'core_contract', pageRank: 0.42, importers: 5,
      callers: ['Calculator.compute'],
    };
    const fixture = ['// Adds two numbers.', 'export function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n');

    it('contract 档（归档命中）', async () => {
      symbolsMock.executeSidecarSymbolLookup.mockResolvedValue({ ok: true, found: true, symbol: detail });
      readFileLocalMock.mockResolvedValue(fixture);
      const { runReadSymbol } = await import('@/lib/mcp/tools/symbol');
      const res = await runReadSymbol({ symbol: 'add' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('implementation 档', async () => {
      symbolsMock.executeSidecarSymbolLookup.mockResolvedValue({ ok: true, found: true, symbol: detail });
      readFileLocalMock.mockResolvedValue(fixture);
      const { runReadSymbol } = await import('@/lib/mcp/tools/symbol');
      const res = await runReadSymbol({ symbol: 'add', aspect: 'implementation' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('归档缺失降级 + 黄金符号候选回退', async () => {
      const { runReadSymbol } = await import('@/lib/mcp/tools/symbol');
      const runtime = createRuntime();
      runtime.resolveRepository = async () => ({
        owner: 'acme', repo: 'calculator',
        repository: {
          ...mockRepo,
          repoProfile: {
            codeClusters: [{ title: 'Math Core', cognitive: { goldenSymbols: [{ name: 'add', kind: 'function', file: 'src/math/calc.ts' }], callFlow: [] } }],
          },
        },
        documents: mockRepo.documents,
      });
      const res = await runReadSymbol({ symbol: 'add', aspect: 'implementation' }, runtime);
      expect(text(res)).toMatchSnapshot();
    });

    it('search_symbols 黄金符号清单', async () => {
      symbolsMock.executeSidecarSymbolSearch.mockResolvedValue({ ok: true, symbols: [] });
      const { runSearchSymbols } = await import('@/lib/mcp/tools/symbol');
      const runtime = createRuntime();
      runtime.resolveRepository = async () => ({
        owner: 'acme', repo: 'calculator',
        repository: {
          ...mockRepo,
          repoProfile: {
            codeClusters: [{ title: 'Math Core', cognitive: { goldenSymbols: [{ name: 'add', kind: 'function', file: 'src/math/calc.ts' }], callFlow: [] } }],
          },
        },
      });
      const res = await runSearchSymbols({ query: '' }, runtime);
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('check_breaking_changes（单仓 locator + 空）', () => {
    it('locator 命中', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([
        { id: 'c1', path: 'docs/migrate.md', title: 'Migrate', heading: 'v4 to v5', headingPath: 'v4 to v5', snippet: 'breaking: headers are async now', similarity: 0.9 },
      ]);
      const { runBreakingChanges } = await import('@/lib/mcp/tools/maintenance');
      const res = await runBreakingChanges({ query: 'headers async' }, {}, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('空结果', async () => {
      docSearchMock.locateRepositorySections.mockResolvedValue([]);
      const { runBreakingChanges } = await import('@/lib/mcp/tools/maintenance');
      const res = await runBreakingChanges({ query: 'nothing' }, {}, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('read_source_file（命中 / 行区间 / 未命中）', () => {
    const fixture = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

    it('全文命中', async () => {
      readFileLocalMock.mockResolvedValue(fixture);
      const { runReadSourceFile } = await import('@/lib/mcp/tools/source-file');
      const res = await runReadSourceFile({ path: 'src/calc.ts' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('行区间', async () => {
      readFileLocalMock.mockResolvedValue(fixture);
      const { runReadSourceFile } = await import('@/lib/mcp/tools/source-file');
      const res = await runReadSourceFile({ path: 'src/calc.ts', start_line: 3, end_line: 5 }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('未命中（isError）', async () => {
      readFileLocalMock.mockResolvedValue(null);
      const { runReadSourceFile } = await import('@/lib/mcp/tools/source-file');
      const res = await runReadSourceFile({ path: 'missing.ts' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('list_chapter_versions（有版本 / 无版本）', () => {
    it('版本市场列表', async () => {
      prismaMock.document.findFirst.mockResolvedValue({ id: 'doc-1', path: 'ch01.md', title: 'Ch1', contentId: 'content-aaa' });
      prismaMock.chapterVersion.findMany.mockResolvedValue([
        { id: 'ver-1', source: 'RETRANSLATE', voteCount: 7, isCanonical: false, pinnedAt: null, createdAt: new Date('2026-01-01'), contentId: 'content-bbb', author: { name: 'alice' } },
        { id: 'ver-2', source: 'RELAY', voteCount: 2, isCanonical: true, pinnedAt: new Date('2026-02-01'), createdAt: new Date('2026-01-15'), contentId: 'content-aaa', author: { name: 'bob' } },
      ]);
      const { runListChapterVersions } = await import('@/lib/mcp/tools/versions');
      const res = await runListChapterVersions({ path: 'ch01.md' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('无社区版本', async () => {
      prismaMock.document.findFirst.mockResolvedValue({ id: 'doc-1', path: 'ch01.md', title: 'Ch1', contentId: 'content-aaa' });
      prismaMock.chapterVersion.findMany.mockResolvedValue([]);
      const { runListChapterVersions } = await import('@/lib/mcp/tools/versions');
      const res = await runListChapterVersions({ path: 'ch01.md' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });
  });

  describe('dissect_code（命中 / 过大拒绝）', () => {
    it('AST 解剖输出', async () => {
      readFileLocalMock.mockResolvedValue('function main() {\n  call();\n}');
      dissectMock.executeSidecarDissectAst.mockResolvedValue({ mermaidCode: 'graph TD\n  A-->B', nodes: [], edges: [], language: 'ts', isAst: true });
      const { runDissectCode } = await import('@/lib/mcp/tools/dissect');
      const res = await runDissectCode({ path: 'src/main.ts' }, createRuntime());
      expect(text(res)).toMatchSnapshot();
    });

    it('超大输入拒绝（isError）', async () => {
      readFileLocalMock.mockResolvedValue('x'.repeat(21000));
      const { runDissectCode } = await import('@/lib/mcp/tools/dissect');
      const res = await runDissectCode({ path: 'src/big.ts' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(text(res)).toMatchSnapshot();
    });
  });
});
