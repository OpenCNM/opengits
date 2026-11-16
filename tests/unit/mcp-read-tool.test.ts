import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRead, capFullDocText } from '@/lib/mcp/tools/read';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';

const prismaMock = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
  },
  documentChunk: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

vi.mock('@/lib/mcp/grounding-beacon', () => ({
  projectProvenanceBeacon: vi.fn(() => '\n\n---\n* Provenance Beacon: Verified AST'),
}));

vi.mock('@/lib/mcp/concept-graph', () => ({
  buildGraphPositionText: vi.fn(async () => ''),
}));

describe('MCP read Tool (First-Principles Content & Slice Read)', () => {
  const mockRepo = {
    id: 'repo-micro-1',
    owner: 'karpathy',
    repo: 'micrograd',
    branch: 'master',
    gitSha: 'sha-micro-7bc',
  };

  const createRuntime = (repo: any = mockRepo, multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async () => ({
      owner: repo.owner,
      repo: repo.repo,
      repository: {
        ...repo,
        documents: [
          { id: 'doc-1', path: 'chapters/01.mdx', title: 'Chapter 1' },
        ],
      },
      documents: [
        { id: 'doc-1', path: 'chapters/01.mdx', title: 'Chapter 1' },
      ],
      navTree: [],
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.document.findFirst.mockReset();
    prismaMock.documentChunk.findFirst.mockReset();
  });

  describe('capFullDocText 超长截断与提示', () => {
    it('短文本不截断', () => {
      const short = 'Hello world';
      expect(capFullDocText(short)).toBe(short);
    });

    it('超出 MCP_DOC_FULL_MAX_CHARS 时裁剪并附带 outline 指引', () => {
      const long = 'A'.repeat(MCP_DOC_FULL_MAX_CHARS + 500);
      const capped = capFullDocText(long);
      expect(capped.length).toBeLessThan(long.length);
      expect(capped).toContain('[Truncated for context limit. Use outline for the table of contents');
    });
  });

  describe('runRead 入参校验与别名兼容', () => {
    it('缺少 target 与 path 参数时返回错误', async () => {
      const res = await runRead({}, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Error: "target" is required');
    });

    it('path 参数可作为 target 的等价别名', async () => {
      prismaMock.document.findFirst.mockResolvedValue({
        content: '# Chapter 1 Content',
        contentId: 'cid-1',
      });

      const res = await runRead({ path: 'chapters/01.mdx' }, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('# Chapter 1 Content');
    });

    it('Hub 模式未提供 repository 参数时提示 scopeRequiredError', async () => {
      const res = await runRead({ target: 'chapters/01.mdx' }, createRuntime(mockRepo, true));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('"repository" is required on the Hub');
    });

    it('未找到目标文档时返回 isError 与 outline 寻径指引', async () => {
      const res = await runRead({ target: 'nonexistent.md' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Document "nonexistent.md" not found in karpathy/micrograd');
    });
  });

  describe('aspect 认知深度过滤', () => {
    const rawChapterMarkdown = [
      '# Value 标量节点与自动微分',
      '',
      '这里是一大段教学散文，解释为什么我们需要标量闭包...',
      '还有更多设计哲学阐述，占用了几百个 Token 的篇幅。',
      '',
      '```python',
      'class Value:',
      '    def __init__(self, data):',
      '        self.data = data',
      '        self.grad = 0',
      '```',
      '',
      '| 方法名 | 参数 | 返回值 |',
      '| :--- | :--- | :--- |',
      '| backward | 无 | void |',
    ].join('\n');

    it('aspect="contract" 剥离教学散文，仅保留代码块与契约表格', async () => {
      prismaMock.document.findFirst.mockResolvedValue({
        content: rawChapterMarkdown,
        contentId: 'cid-1',
      });

      const res = await runRead({ target: 'chapters/01.mdx', aspect: 'contract' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('class Value:');
      expect(text).toContain('| backward | 无 | void |');
      // 确认散文已被剥离
      expect(text).not.toContain('这里是一大段教学散文');
      expect(text).not.toContain('还有更多设计哲学阐述');
    });

    it('aspect="full" 返回完整长文与 Provenance Beacon 溯源页脚', async () => {
      prismaMock.document.findFirst.mockResolvedValue({
        content: rawChapterMarkdown,
        contentId: 'cid-1',
      });

      const res = await runRead({ target: 'chapters/01.mdx', aspect: 'full' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('这里是一大段教学散文');
      expect(text).toContain('class Value:');
      expect(text).toContain('Provenance Beacon: Verified AST');
    });
  });

  describe('Address 锚点切片精读 (path#heading)', () => {
    it('target 带锚点时精准提取对应切片', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([
        {
          heading: '核心求导闭包',
          headingPath: '第 1 章 > 核心求导闭包',
          content: 'def _backward(): self.grad += out.grad',
          semVerLabel: null,
        },
      ]);

      const res = await runRead({ target: 'chapters/01.mdx#核心求导闭包' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Section: 核心求导闭包');
      expect(text).toContain('def _backward(): self.grad += out.grad');
    });
  });
});
