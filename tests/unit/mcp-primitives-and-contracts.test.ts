import { describe, it, expect } from 'vitest';
import { runOutline, formatNavTree, findDocInContext } from '@/lib/mcp/tools/outline';
import { runRead, capFullDocText, filterDocByAspect } from '@/lib/mcp/tools/read';
import { runReadDocument } from '@/lib/mcp/tools/document';
import { runSearch } from '@/lib/mcp/tools/search';
import { RepoRuntime } from '@/lib/mcp/tools/shared';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';
import { TOOL_CONTRACTS, MCP_AVAILABLE_TOOLS, BUNDLE_TOOL_CONTRACTS, contractFor, contractDescription, HUB_SUFFIXES } from '@/lib/mcp/tool-contracts';
import { maskToken, getClientConfigJson, getClientAiPrompt, SUPPORTED_CLIENT_TYPES } from '@/components/mcp-connect/mcp-client-configs';

describe('mcp-primitives-and-contracts', () => {
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
      { type: 'page', title: 'Architecture', path: 'architecture.md' },
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

  it('outline 原语：紧凑导航树、条目上限保护、大小写/后缀容差查找与缺失错误指引', async () => {
    const res = await runOutline({}, mockRuntime);
    const text = res.content[0].text;
    expect(text).toContain('Available Documentation in test-owner/test-repo:');
    expect(text).toContain('📁 Getting Started');
    expect(text.split('\n').length).toBeLessThan(50);

    const hugeTree = Array.from({ length: 150 }, (_, i) => ({ type: 'page' as const, title: `Doc ${i}`, path: `docs/doc-${i}.md` }));
    const truncated = formatNavTree(hugeTree, '', 20);
    expect(truncated.count).toBe(20);
    expect(truncated.text).toContain('... [More documents available');

    const ctx = { owner: 'test', repo: 'test', repository: mockRepository as any };
    expect(findDocInContext(ctx, 'intro')?.id).toBe('doc-1');
    expect(findDocInContext(ctx, 'INTRO.MD')?.id).toBe('doc-1');
    expect(findDocInContext(ctx, 'non-existent')).toBeUndefined();

    const ghost = await runOutline({ path: 'ghost.md' }, mockRuntime);
    expect((ghost as any).isError).toBe(true);
    expect(ghost.content[0].text).toContain('Document not found: "ghost.md"');
  });

  it('read 原语：空 target / 未命中 / capFullDocText / aspect 过滤与 deep-dive 隔离', async () => {
    expect(((await runRead({ target: '' }, mockRuntime)) as any).isError).toBe(true);
    const missing = await runRead({ target: 'missing-file.md' }, mockRuntime);
    expect((missing as any).isError).toBe(true);
    expect(missing.content[0].text).toContain('Document "missing-file.md" not found');

    expect(capFullDocText('Hello world')).toBe('Hello world');
    expect(capFullDocText('A'.repeat(MCP_DOC_FULL_MAX_CHARS + 500))).toContain('Truncated for context limit');

    const archDoc = `# Title\n\nNarrative paragraph.\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\``;
    const arch = filterDocByAspect(archDoc, 'architecture');
    expect(arch).toContain('Code implementation omitted in architecture mode');
    expect(arch).not.toContain('const a = 1;');

    const contractDoc = `# Title\n\nNarrative paragraph.\n\n\`\`\`ts\nexport function calc(): number;\n\`\`\`\n\n| Param | Type |\n| --- | --- |\n| a | number |\n`;
    const contract = filterDocByAspect(contractDoc, 'contract');
    expect(contract).toContain('export function calc(): number;');
    expect(contract).not.toContain('Narrative paragraph.');

    const deepDoc = `# Chapter\n\nMainline overview.\n\n<details data-layer="deep">\n<summary>源码深潜</summary>\n\n\`\`\`ts\nfunction internalSecret() { return 42; }\n\`\`\`\n\n</details>`;
    expect(filterDocByAspect(deepDoc, 'architecture')).not.toContain('internalSecret');
    expect(filterDocByAspect(deepDoc, 'contract')).not.toContain('internalSecret');
    expect(filterDocByAspect(deepDoc, 'full')).toContain('internalSecret');
  });

  it('search & 向下兼容门面 read_document 委托', async () => {
    const dummyRuntime: RepoRuntime = { label: 'test', multiRepo: false, resolveRepository: async () => null, listRepositories: async () => [] };
    expect(await runSearch({ query: 'async headers', filter: 'gotchas' }, {}, dummyRuntime)).toBeDefined();

    expect((await runReadDocument({}, mockRuntime)).content[0].text).toContain('Available Documentation in test-owner/test-repo:');
    expect(((await runReadDocument({ path: 'ghost.md' }, mockRuntime)) as any).isError).toBe(true);
    expect((await runReadDocument({ section: 'intro.md#Overview' }, mockRuntime)).content).toBeDefined();
  });

  it('TOOL_CONTRACTS 4 大核心原语顺序/Schema/hubSuffix 与 BUNDLE 守恒', () => {
    const validSuffixes = new Set(['fanout', 'required', 'none']);
    expect(TOOL_CONTRACTS.length).toBe(MCP_AVAILABLE_TOOLS.length);
    expect([...MCP_AVAILABLE_TOOLS]).toEqual(['browse', 'search', 'read', 'read_code']);
    expect(BUNDLE_TOOL_CONTRACTS.map((t) => t.name)).toEqual(['browse', 'search', 'read', 'read_code']);

    for (let i = 0; i < TOOL_CONTRACTS.length; i++) {
      const tool = TOOL_CONTRACTS[i];
      expect(tool.name).toBe(MCP_AVAILABLE_TOOLS[i]);
      expect(tool.canonicalOrder).toBe(i + 1);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(validSuffixes.has(tool.hubSuffix)).toBe(true);

      const hubShape = tool.hubSchema.shape as any;
      if (tool.hubSuffix === 'required') {
        expect(hubShape.repository.isOptional()).toBe(false);
      } else if (tool.hubSuffix === 'fanout') {
        expect(hubShape.repository.isOptional()).toBe(true);
      }
    }

    expect(contractDescription('browse', false)).toBe(contractFor('browse')!.description);
    expect(contractDescription('browse', true)).toContain(HUB_SUFFIXES.fanout);
    expect(contractDescription('read', true)).toContain(HUB_SUFFIXES.required);
    expect(contractDescription('read_code', true)).toContain(HUB_SUFFIXES.required);
  });

  it('mcp-client-configs: maskToken 脱敏与各客户端 JSON/Prompt 配置生成', () => {
    expect(maskToken('')).toBe('');
    expect(maskToken('12345678')).toBe('123456****');
    const realToken = 'opgts_f9b27b59789fa1530ee063a8f20c5560';
    const masked = maskToken(realToken);
    expect(masked).toBe('opgts_f9****5560');
    expect(masked).not.toContain('789fa1530ee063a8f20c');

    const endpoint = 'http://localhost:3000/api/mcp/hub';
    expect(JSON.parse(getClientConfigJson('cursor', endpoint)).mcpServers.opengits.headers.Authorization).toBe('Bearer YOUR_MCP_API_TOKEN');
    expect(getClientConfigJson('cursor', endpoint, masked)).not.toContain(realToken);
    expect(JSON.parse(getClientConfigJson('cursor', endpoint, realToken)).mcpServers.opengits.headers.Authorization).toBe(`Bearer ${realToken}`);
    for (const client of SUPPORTED_CLIENT_TYPES) {
      expect(JSON.parse(getClientConfigJson(client, endpoint, masked)).mcpServers.opengits.headers.Authorization).toBe(`Bearer ${masked}`);
    }
    expect(getClientAiPrompt('cursor', endpoint, realToken)).toContain(realToken);
  });
});
