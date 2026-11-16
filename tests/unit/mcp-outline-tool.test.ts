import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOutline, formatNavTree, findDocInContext } from '@/lib/mcp/tools/outline';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { NavNode } from '@/engine/structurizer';

const prismaMock = vi.hoisted(() => ({
  documentChunk: {
    findMany: vi.fn(),
  },
  tutorialConceptNode: {
    findMany: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const outlineProjectorMock = vi.hoisted(() => ({
  getEffectiveNavTree: vi.fn(),
}));
vi.mock('@/lib/mcp/outline-projector', () => outlineProjectorMock);

const conceptGraphMock = vi.hoisted(() => ({
  buildRepositoryConceptTaxonomy: vi.fn(),
  formatConceptTaxonomyGrouped: vi.fn(),
  CONCEPT_TAXONOMY_HEADER: '核心概念图谱清单 (Key Concepts in this Document)',
}));
vi.mock('@/lib/mcp/concept-graph', async () => {
  const actual = await vi.importActual<any>('@/lib/mcp/concept-graph');
  return {
    ...actual,
    ...conceptGraphMock,
  };
});

describe('MCP outline Tool (First-Principles Outline & TOC Sensing)', () => {
  const mockRepo = {
    id: 'repo-lite-1',
    owner: 'antigravity',
    repo: 'gravity-engine',
    branch: 'main',
    gitSha: 'sha-grav-888',
    repoProfile: {
      macroTopologyMermaid: 'graph TD\nCore --> Autograd',
    },
    navTree: [
      {
        type: 'directory' as const,
        title: 'Core Engine',
        children: [
          { type: 'page' as const, title: 'Tensor Basics', path: 'docs/tensor.mdx' },
          { type: 'page' as const, title: 'Autograd', path: 'docs/autograd.mdx' },
        ],
      },
    ],
    documents: [
      { id: 'doc-1', title: 'Tensor Basics', path: 'docs/tensor.mdx', summary: 'Multidimensional arrays' },
      { id: 'doc-2', title: 'Autograd', path: 'docs/autograd.mdx', summary: 'Reverse-mode AD' },
    ],
  };

  const createRuntime = (repo: any = mockRepo, multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async (scope?: string) => {
      if (scope && scope !== `${repo.owner}/${repo.repo}` && scope !== repo.id) {
        return null;
      }
      return {
        owner: repo.owner,
        repo: repo.repo,
        repository: repo,
        documents: repo.documents || [],
        navTree: repo.navTree || [],
      };
    },
    listRepositories: async () => [
      {
        owner: repo.owner,
        repo: repo.repo,
        repository: repo,
        documents: repo.documents || [],
        navTree: repo.navTree || [],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.documentChunk.findMany.mockReset().mockResolvedValue([]);
    prismaMock.tutorialConceptNode.findMany.mockReset().mockResolvedValue([]);
    outlineProjectorMock.getEffectiveNavTree.mockReset().mockResolvedValue([]);
    conceptGraphMock.buildRepositoryConceptTaxonomy.mockReset().mockResolvedValue([]);
    conceptGraphMock.formatConceptTaxonomyGrouped.mockReset().mockReturnValue('');
  });

  describe('formatNavTree 纯函数与边界保护', () => {
    it('空列表与非数组入参返回空文本与零计数', () => {
      expect(formatNavTree(undefined)).toEqual({ text: '', count: 0 });
      expect(formatNavTree([])).toEqual({ text: '', count: 0 });
    });

    it('格式化目录树与多级缩进', () => {
      const tree: NavNode[] = [
        {
          type: 'directory',
          title: 'Section A',
          children: [
            { type: 'page', title: 'Doc A1', path: 'a/1.md' },
          ],
        },
        { type: 'page', title: 'Doc B', path: 'b.md' },
      ];
      const res = formatNavTree(tree);
      expect(res.count).toBe(3);
      expect(res.text).toContain('📁 Section A\n');
      expect(res.text).toContain('  📄 Doc A1 (a/1.md)\n');
      expect(res.text).toContain('📄 Doc B (b.md)\n');
    });

    it('超出 60 条目上限时自动截断并附带提示', () => {
      const items: NavNode[] = Array.from({ length: 65 }, (_, i) => ({
        type: 'page',
        title: `Document ${i + 1}`,
        path: `doc-${i + 1}.md`,
      }));
      const res = formatNavTree(items, '', 60);
      expect(res.count).toBe(60);
      expect(res.text).toContain('📄 Document 60');
      expect(res.text).not.toContain('📄 Document 61');
      expect(res.text).toContain('... [More documents available; pass "path" to inspect specific document headings or use search]');
    });
  });

  describe('findDocInContext 路径容差匹配', () => {
    const ctx: any = {
      repository: {
        documents: [
          { id: '1', path: 'guides/getting-started.mdx' },
          { id: '2', path: 'API/CONFIG.MD' },
        ],
      },
    };

    it('精确匹配', () => {
      expect(findDocInContext(ctx, 'guides/getting-started.mdx')?.id).toBe('1');
    });

    it('.mdx 后缀容差与省略匹配', () => {
      expect(findDocInContext(ctx, 'guides/getting-started')?.id).toBe('1');
    });

    it('大小写不敏感匹配', () => {
      expect(findDocInContext(ctx, 'api/config.md')?.id).toBe('2');
      expect(findDocInContext(ctx, 'api/config')?.id).toBe('2');
    });

    it('不存在路径返回 undefined', () => {
      expect(findDocInContext(ctx, 'non-existent')).toBeUndefined();
    });
  });

  describe('runOutline 仓库级导航树 (Repo Outline Mode)', () => {
    it('Hub 模式未指定 repository 时提示 scopeRequiredError', async () => {
      const res = await runOutline({}, createRuntime(mockRepo, true));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('"repository" is required on the Hub');
    });

    it('指定不存在的仓库时提示 refNotFoundError', async () => {
      const res = await runOutline({ repository: 'nonexistent/repo' }, createRuntime(mockRepo, true));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Repository "nonexistent/repo" not found');
    });

    it('输出包含宏观拓扑概览与导航树', async () => {
      outlineProjectorMock.getEffectiveNavTree.mockResolvedValue(mockRepo.navTree);
      conceptGraphMock.buildRepositoryConceptTaxonomy.mockResolvedValue([
        { conceptName: 'Tensor', category: 'Core' },
      ]);
      conceptGraphMock.formatConceptTaxonomyGrouped.mockReturnValue('### Knowledge Graph Concepts\n- Tensor (Core)');

      const res = await runOutline({}, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Architecture Topology (C4 L1 System Context)');
      expect(text).toContain('graph TD\nCore --> Autograd');
      expect(text).toContain('Available Documentation in antigravity/gravity-engine:');
      expect(text).toContain('📁 Core Engine');
      expect(text).toContain('📄 Tensor Basics (docs/tensor.mdx)');
      expect(text).toContain('### Knowledge Graph Concepts');
      expect(text).toContain('- Tensor (Core)');
    });

    it('navTree 为空时降级为平铺 documents 列表', async () => {
      outlineProjectorMock.getEffectiveNavTree.mockResolvedValue([]);
      const flatRepo = {
        ...mockRepo,
        repoProfile: {},
        navTree: [],
      };

      const res = await runOutline({}, createRuntime(flatRepo));
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('- Tensor Basics (docs/tensor.mdx)');
      expect(text).toContain('- Autograd (docs/autograd.mdx)');
      expect(text).toContain('Next steps: use outline with "path" to inspect document headings');
    });
  });

  describe('runOutline 单文档深钻 (Document TOC Drill-down Mode)', () => {
    it('指定不存在的文档时返回错误提示与寻径建议', async () => {
      const res = await runOutline({ path: 'missing.md' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Document not found: "missing.md" in antigravity/gravity-engine');
      expect(res.content[0].text).toContain('Call outline without "path" to see available documents.');
    });

    it('存在文档但无 Chunk 时提示使用 read 获取全文', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([]);
      const res = await runOutline({ path: 'docs/tensor.mdx' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('📄 Tensor Basics');
      expect(text).toContain('Path: docs/tensor.mdx');
      expect(text).toContain('Summary: Multidimensional arrays');
      expect(text).toContain('(No internal heading chunks available. Use read with target="docs/tensor.mdx" to read the full page.)');
    });

    it('解析内部 Heading Chunks 输出层级缩进与 Address 定位锚点', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([
        { heading: '前言', headingPath: '前言', contentType: 'prose' },
        { heading: '内存布局', headingPath: '基础概念 > 内存布局', contentType: 'code_example' },
        { heading: '跨步计算', headingPath: '基础概念 > 内存布局 > 跨步计算', contentType: 'prose' },
      ]);
      prismaMock.tutorialConceptNode.findMany.mockResolvedValue([
        { conceptName: 'StridedTensor', category: 'Storage', headingPath: '基础概念 > 内存布局' },
      ]);

      const res = await runOutline({ path: 'docs/tensor.mdx' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('- 前言 [Address: docs/tensor.mdx#前言]');
      expect(text).toContain('  - 内存布局 [code_example] [Address: docs/tensor.mdx#基础概念 > 内存布局]');
      expect(text).toContain('    - 跨步计算 [Address: docs/tensor.mdx#基础概念 > 内存布局 > 跨步计算]');
      expect(text).toContain('## 核心概念图谱清单 (Key Concepts in this Document)');
      expect(text).toContain('- StridedTensor (Storage) — docs/tensor.mdx [Address: docs/tensor.mdx#基础概念 > 内存布局]');
      expect(text).toContain('(Use read with target="docs/tensor.mdx" for the whole document, or target="<Address>" to read a specific section)');
    });
  });
});
