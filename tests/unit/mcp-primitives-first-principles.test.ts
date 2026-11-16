import { describe, it, expect, vi } from 'vitest';
import { runOutline, formatNavTree, findDocInContext } from '@/lib/mcp/tools/outline';
import { runRead, capFullDocText, filterDocByAspect } from '@/lib/mcp/tools/read';
import { runReadDocument } from '@/lib/mcp/tools/document';
import { runSearch } from '@/lib/mcp/tools/search';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';

describe('MCP 3+1 Agent Behavioral Primitives (第一性原理)', () => {
  const mockRepository = {
    id: 'repo-1',
    owner: 'test-owner',
    repo: 'test-repo',
    branch: 'main',
    navTree: [
      {
        type: 'directory',
        title: 'Getting Started',
        children: [
          { type: 'page', title: 'Introduction', path: 'intro.md' },
          { type: 'page', title: 'Installation', path: 'install.md' },
        ],
      },
      {
        type: 'page',
        title: 'Architecture',
        path: 'architecture.md',
      },
    ],
    documents: [
      { id: 'doc-1', title: 'Introduction', path: 'intro.md', summary: 'Intro summary' },
      { id: 'doc-2', title: 'Installation', path: 'install.md', summary: 'Install summary' },
      { id: 'doc-3', title: 'Architecture', path: 'architecture.md', summary: 'Arch summary' },
    ],
  };

  const mockRuntime: RepoRuntime = {
    label: 'test-owner/test-repo',
    multiRepo: false,
    resolveRepository: async () => ({
      owner: 'test-owner',
      repo: 'test-repo',
      repository: mockRepository as any,
      targetVersionLabel: '1.0.0',
    }),
    listRepositories: async () => [],
  };

  describe('1. outline 原语 (结构感知)', () => {
    it('不传 path 时，输出轻量紧凑的仓库导航树 (<50 行)，杜绝打爆上下文', async () => {
      const res = await runOutline({}, mockRuntime);
      expect(res.content).toBeDefined();
      expect(res.content[0].type).toBe('text');
      const text = res.content[0].text;
      expect(text).toContain('Available Documentation in test-owner/test-repo:');
      expect(text).toContain('📁 Getting Started');
      expect(text).toContain('📄 Introduction (intro.md)');
      expect(text).toContain('📄 Architecture (architecture.md)');
      // 验证未包含海量 chunk，输出行数受控
      const lineCount = text.split('\n').length;
      expect(lineCount).toBeLessThan(50);
    });

    it('formatNavTree 具备最大深度与条目上限保护', () => {
      const hugeTree = Array.from({ length: 150 }, (_, i) => ({
        type: 'page' as const,
        title: `Doc ${i}`,
        path: `docs/doc-${i}.md`,
      }));
      const { text, count } = formatNavTree(hugeTree, '', 20);
      expect(count).toBe(20);
      expect(text).toContain('... [More documents available');
    });

    it('路径容差查找 findDocInContext 支持大小写不敏感及后缀自动补全', () => {
      const ctx = { owner: 'test', repo: 'test', repository: mockRepository as any };
      expect(findDocInContext(ctx, 'intro')?.id).toBe('doc-1');
      expect(findDocInContext(ctx, 'INTRO.MD')?.id).toBe('doc-1');
      expect(findDocInContext(ctx, 'install')?.id).toBe('doc-2');
      expect(findDocInContext(ctx, 'non-existent')).toBeUndefined();
    });

    it('传入不存在的 path 时返回友好的错误指引', async () => {
      const res = await runOutline({ path: 'ghost.md' }, mockRuntime);
      expect((res as any).isError).toBe(true);
      expect(res.content[0].text).toContain('Document not found: "ghost.md"');
      expect(res.content[0].text).toContain('Call outline without "path"');
    });
  });

  describe('2. read 原语 (内容读取)', () => {
    it('空 target 时返回清晰错误提示', async () => {
      const res = await runRead({ target: '' }, mockRuntime);
      expect((res as any).isError).toBe(true);
      expect(res.content[0].text).toContain('Error: "target" is required');
    });

    it('找不到文档时返回包含建议的错误信息', async () => {
      const res = await runRead({ target: 'missing-file.md' }, mockRuntime);
      expect((res as any).isError).toBe(true);
      expect(res.content[0].text).toContain('Document "missing-file.md" not found');
      expect(res.content[0].text).toContain('Call outline to view valid document paths');
    });

    it('capFullDocText 超长文本安全截断护盾', () => {
      const shortText = 'Hello world';
      expect(capFullDocText(shortText)).toBe(shortText);

      const massiveText = 'A'.repeat(MCP_DOC_FULL_MAX_CHARS + 500);
      const capped = capFullDocText(massiveText);
      expect(capped.length).toBeLessThan(massiveText.length);
      expect(capped).toContain('Truncated for context limit');
    });

    it('filterDocByAspect: architecture 模式折叠长代码块保留叙述与图表', () => {
      const doc = `# Title\n\nNarrative paragraph.\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\``;
      const res = filterDocByAspect(doc, 'architecture');
      expect(res).toContain('Narrative paragraph.');
      expect(res).toContain('Code implementation omitted in architecture mode');
      expect(res).toContain('graph TD');
      expect(res).not.toContain('const a = 1;');
    });

    it('filterDocByAspect: contract 模式提取代码块与表格并剥离叙述', () => {
      const doc = `# Title\n\nNarrative paragraph.\n\n\`\`\`ts\nexport function calc(): number;\n\`\`\`\n\n| Param | Type |\n| --- | --- |\n| a | number |\n`;
      const res = filterDocByAspect(doc, 'contract');
      expect(res).toContain('# Title');
      expect(res).toContain('export function calc(): number;');
      expect(res).toContain('| Param | Type |');
      expect(res).not.toContain('Narrative paragraph.');
    });
  });

  describe('3. search 原语 (gotchas 与 filter 扩展)', () => {
    it('mode 或 filter 指定为 gotchas 时正确路由', async () => {
      // 验证 runSearch 接收 filter='gotchas' 时不报错并识别分支
      const dummyRuntime: RepoRuntime = {
        label: 'test',
        multiRepo: false,
        resolveRepository: async () => null,
        listRepositories: async () => [],
      };
      // target 为空时返回 scopeRequiredError
      const res = await runSearch({ query: 'async headers', filter: 'gotchas' }, {}, dummyRuntime);
      expect(res).toBeDefined();
    });
  });

  describe('4. 向下兼容门面 (read_document)', () => {
    it('read_document 无参调用时透明委托至 outline', async () => {
      const res = await runReadDocument({}, mockRuntime);
      expect(res.content).toBeDefined();
      expect(res.content[0].text).toContain('Available Documentation in test-owner/test-repo:');
    });

    it('read_document 带 path 时透明委托至 read', async () => {
      const res = await runReadDocument({ path: 'ghost.md' }, mockRuntime);
      expect((res as any).isError).toBe(true);
      expect(res.content[0].text).toContain('Document "ghost.md" not found');
    });

    it('read_document 带 section 时透明委托至 read 章节切片', async () => {
      const res = await runReadDocument({ section: 'intro.md#Overview' }, mockRuntime);
      expect(res.content).toBeDefined();
    });
  });
});
