import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractGroundingFacts,
  projectProvenanceBeacon,
  buildProvenanceBeacon,
} from '@/lib/mcp/grounding-beacon';
import { runRead } from '@/lib/mcp/tools/read';
import { estimateTokens } from '@/lib/token-counter';

// ── Mock DB 面 ──
const prismaMock = vi.hoisted(() => ({
  documentChunk: { findMany: vi.fn() },
  document: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

vi.mock('@/lib/mcp/concept-graph', () => ({
  buildGraphPositionText: vi.fn(async () => ''),
}));

const mockRepo = {
  id: 'repo-1',
  owner: 'acme',
  repo: 'calculator',
  branch: 'main',
  gitSha: 'sha-123',
  repoProfile: {},
  navTree: [],
  documents: [
    { id: 'doc-1', title: 'Guide', path: 'docs/guide.md', summary: 'Intro guide' },
  ],
};

function createRuntime(multiRepo = false) {
  return {
    multiRepo,
    resolveRepository: async () => ({
      owner: 'acme',
      repo: 'calculator',
      repository: mockRepo,
      documents: mockRepo.documents,
      navTree: mockRepo.navTree,
    }),
  } as any;
}

const textOf = (res: any) => (res?.content?.[0]?.text ?? '') as string;

describe('MCP Grounding Beacon (零物化溯源信标)', () => {
  describe('extractGroundingFacts (事实提取器)', () => {
    it('处理空串或无效输入，返回空数组', () => {
      expect(extractGroundingFacts('')).toEqual({ symbols: [], sourceFiles: [], sourceFacts: [] });
      expect(extractGroundingFacts('   \n\t  ')).toEqual({ symbols: [], sourceFiles: [], sourceFacts: [] });
    });

    it('从代码围栏 meta 注释中提取代码文件路径', () => {
      const md = [
        '```typescript // src/engine/scheduler.ts',
        'export function schedule() {}',
        '```',
        '```go # internal/store/kv.go',
        'type Store struct{}',
        '```',
        '```sql -- migrations/001_init.sql',
        'CREATE TABLE test;',
        '```',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('src/engine/scheduler.ts');
      expect(facts.sourceFiles).toContain('internal/store/kv.go');
      expect(facts.sourceFiles).toContain('migrations/001_init.sql');
    });

    it('从代码围栏属性（title / filename / path / file）中提取代码文件路径且无噪音重复', () => {
      const md = [
        '```typescript title="src/engine/scheduler.ts"',
        'export function schedule() {}',
        '```',
        '```go filename="internal/store/kv.go"',
        'type Store struct{}',
        '```',
        '```python path="scripts/build.py"',
        'print("build")',
        '```',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toEqual([
        'src/engine/scheduler.ts',
        'internal/store/kv.go',
        'scripts/build.py',
      ]);
      // 保证属性名未被当作文件路径片段泄露
      expect(facts.sourceFiles.some((f) => f.includes('title='))).toBe(false);
      expect(facts.sourceFiles.some((f) => f.includes('filename='))).toBe(false);
      expect(facts.sourceFiles.some((f) => f.includes('path='))).toBe(false);
    });

    it('从代码块首行注释（含前面有空行）中提取文件声明', () => {
      const md = [
        '```typescript',
        '',
        '// src/components/button.tsx',
        'export const Button = () => null;',
        '```',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toEqual(['src/components/button.tsx']);
    });

    it('代码块前 3 行内存在路径注释时成功识别，不被首行非路径注释提前截断', () => {
      const md = [
        '```typescript',
        '// Copyright (c) 2026 Acme Corp. All rights reserved.',
        '// src/auth/token-signer.ts',
        'export function sign() {}',
        '```',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('src/auth/token-signer.ts');
    });

    it('识别无扩展名的常见构建与源码文件名（如 Dockerfile, Makefile）', () => {
      const md = [
        '```dockerfile // Dockerfile',
        'FROM node:20',
        '```',
        '```makefile',
        '# Makefile',
        'build:',
        '\tnpm run build',
        '```',
        'Check `deploy/Dockerfile`, `Caddyfile` and `Makefile` for setup.',
        '```ts',
        '// filepath: src/server/bootstrap.ts',
        'export function boot() {}',
        '```',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('Dockerfile');
      expect(facts.sourceFiles).toContain('Makefile');
      expect(facts.sourceFiles).toContain('Caddyfile');
      expect(facts.sourceFiles).toContain('deploy/Dockerfile');
      expect(facts.sourceFiles).toContain('src/server/bootstrap.ts');
    });

    it('从 HTML 注释中提取 path 声明', () => {
      const md = [
        '<!-- path: src/lib/mcp/tool-contracts.ts -->',
        'Some explanation about contracts.',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toEqual(['src/lib/mcp/tool-contracts.ts']);
    });

    it('从行内代码提取源码路径并忽略教程文档路径', () => {
      const md = 'See `src/index.ts` and `internal/worker.go` for implementation. Refer to `docs/getting-started.md` for tutorial.';
      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('src/index.ts');
      expect(facts.sourceFiles).toContain('internal/worker.go');
      expect(facts.sourceFiles).not.toContain('docs/getting-started.md');
    });

    it('从行内代码提取根目录源码文件（如 main.go, app.ts）与带行号/锚点路径（如 src/foo.ts:42, src/foo.ts#L10）', () => {
      const md = 'Entry point is `main.go` and `app.ts`. Also inspect `src/foo.ts:42` and `src/bar.rs#L10`.';
      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('main.go');
      expect(facts.sourceFiles).toContain('app.ts');
      expect(facts.sourceFiles).toContain('src/foo.ts');
      expect(facts.sourceFiles).toContain('src/bar.rs');
      // 确保根目录源码文件未被误判为代码符号
      expect(facts.symbols).not.toContain('main.go');
      expect(facts.symbols).not.toContain('app.ts');
    });

    it('提取源码文件时保留行号闭区间 (startLine 与 endLine)', () => {
      const md = [
        '```ts // src/scheduler.ts (L15-L50)',
        'export const a = 1;',
        '```',
        'Also see `src/foo.ts:42-60` and `src/single.ts:99` or [link](code:src/bar.rs#L10-L20).',
      ].join('\n');

      const facts = extractGroundingFacts(md);
      expect(facts.sourceFacts).toEqual(
        expect.arrayContaining([
          { path: 'src/scheduler.ts', startLine: 15, endLine: 50 },
          { path: 'src/foo.ts', startLine: 42, endLine: 60 },
          { path: 'src/single.ts', startLine: 99, endLine: 99 },
          { path: 'src/bar.rs', startLine: 10, endLine: 20 },
        ])
      );
    });

    it('从行内代码提取代码符号并过滤语法关键字与噪音词', () => {
      const md = 'Call `InitScheduler` or `runRead` or `Calculator.compute`. Do not use `const`, `return`, `async`, or `true`.';
      const facts = extractGroundingFacts(md);
      expect(facts.symbols).toContain('InitScheduler');
      expect(facts.symbols).toContain('runRead');
      expect(facts.symbols).toContain('Calculator.compute');
      expect(facts.symbols).not.toContain('const');
      expect(facts.symbols).not.toContain('return');
      expect(facts.symbols).not.toContain('async');
      expect(facts.symbols).not.toContain('true');
    });

    it('从行内代码提取函数调用符号并自动剥离括号（如 startWorker() -> startWorker）', () => {
      const md = 'Call `startWorker()` and `calculate()` in your setup pipeline.';
      const facts = extractGroundingFacts(md);
      expect(facts.symbols).toContain('startWorker');
      expect(facts.symbols).toContain('calculate');
    });

    it('支持多种语言扩展名（如 .zig, .dart, .lua）', () => {
      const md = 'Implementations in `kernel/main.zig`, `lib/app.dart`, and `scripts/runner.lua`.';
      const facts = extractGroundingFacts(md);
      expect(facts.sourceFiles).toContain('kernel/main.zig');
      expect(facts.sourceFiles).toContain('lib/app.dart');
      expect(facts.sourceFiles).toContain('scripts/runner.lua');
    });

    it('保留首次出现顺序并自动去重', () => {
      const md = 'Use `InitScheduler` and `runRead`. Then call `InitScheduler` again in `src/app.ts` and `src/app.ts`.';
      const facts = extractGroundingFacts(md);
      expect(facts.symbols).toEqual(['InitScheduler', 'runRead']);
      expect(facts.sourceFiles).toEqual(['src/app.ts']);
    });
  });

  describe('projectProvenanceBeacon (信标投影器)', () => {
    it('单仓模式下，提取到事实时生成紧凑可执行调用模板', () => {
      const md = 'The `parseMarkdownAst` function is in `src/engine/markdown/mdast-ast.ts`.';
      const beacon = projectProvenanceBeacon({
        content: md,
        isMultiRepo: false,
      });

      expect(beacon).toContain('🔍 **Provenance Beacon (L2 Ground Truth)**');
      expect(beacon).toContain('- Symbol: `read_symbol(symbol="parseMarkdownAst")`');
      expect(beacon).toContain('- Source: `read_source_file(path="src/engine/markdown/mdast-ast.ts")`');
      expect(beacon).not.toContain('repository=');
    });

    it('无具体事实时，回退至泛型占位模板', () => {
      const md = 'This is a high level overview without code symbols or file paths.';
      const beacon = projectProvenanceBeacon({
        content: md,
        isMultiRepo: false,
      });

      expect(beacon).toContain('- Symbol: `read_symbol(symbol="<symbol_name>")`');
      expect(beacon).toContain('- Source: `read_source_file(path="<file_path>")`');
    });

    it('多仓 Hub 模式下注入 repository 参数', () => {
      const md = 'Call `InitScheduler` in `src/scheduler.go`.';
      const beacon = projectProvenanceBeacon({
        content: md,
        repository: 'acme/calculator',
        isMultiRepo: true,
      });

      expect(beacon).toContain('- Symbol: `read_symbol(symbol="InitScheduler", repository="acme/calculator")`');
      expect(beacon).toContain('- Source: `read_source_file(path="src/scheduler.go", repository="acme/calculator")`');
    });

    it('多仓 Hub 模式但未传 repository 时回退至 <owner/repo> 占位符', () => {
      const beacon = projectProvenanceBeacon({
        content: '',
        isMultiRepo: true,
      });

      expect(beacon).toContain('- Symbol: `read_symbol(symbol="<symbol_name>", repository="<owner/repo>")`');
      expect(beacon).toContain('- Source: `read_source_file(path="<file_path>", repository="<owner/repo>")`');
    });

    it('发现多个符号或文件时附带 secondary 提示', () => {
      const md = 'Functions `fooBar` and `bazQux` are defined across `src/a.ts` and `src/b.ts`.';
      const beacon = projectProvenanceBeacon({
        content: md,
        isMultiRepo: false,
      });

      expect(beacon).toContain('- Symbol: `read_symbol(symbol="fooBar")` (also: `bazQux`)');
      expect(beacon).toContain('- Source: `read_source_file(path="src/a.ts")` (also: `src/b.ts`)');
    });

    it('严格满足认知预算约束 (< 80 Tokens)', () => {
      const md = 'Complex tutorial content with `alphaBetaGamma` and `deltaEpsilonZeta` in `path/to/very/long/nested/source/file/component.tsx`.';
      const beacon = projectProvenanceBeacon({
        content: md,
        repository: 'very-long-organization-name/very-long-repository-name',
        isMultiRepo: true,
      });

      const estTokens = estimateTokens(beacon);
      expect(estTokens).toBeLessThan(80);
      const wordCount = beacon.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeLessThan(60);
    });

    it('在极端超长路径与超长仓名下硬保证认知预算 (< 80 Tokens)', () => {
      const longPath = 'a/'.repeat(50) + 'component_name_file.ts';
      const longSymbol = 'veryLongSymbolIdentifierNameWhichTakesALotOfCharactersInOutput';
      const md = `\`${longPath}\` and \`${longSymbol}\``;
      const beacon = projectProvenanceBeacon({
        content: md,
        repository: 'long-org/long-repo-name-with-many-hyphens-and-suffixes',
        isMultiRepo: true,
      });

      const estTokens = estimateTokens(beacon);
      expect(estTokens).toBeLessThan(80);
    });

    it('在信标头部渲染紧凑 GitSha 徽标 (时间切片确定性)', () => {
      const md = 'Call `schedule` in `src/scheduler.ts`.';
      const beacon = projectProvenanceBeacon({
        content: md,
        gitSha: '9f8e7d6c5b4a3210',
      });

      expect(beacon).toContain('🔍 **Provenance Beacon (L2 Ground Truth · 9f8e7d6)**');
    });

    it('当提取到代码行区间时，在 read_source_file 模板中渲染 start_line 与 end_line', () => {
      const md = [
        '```typescript // src/engine/scheduler.ts (L10-L45)',
        'export function schedule() {}',
        '```',
      ].join('\n');

      const beacon = projectProvenanceBeacon({
        content: md,
      });

      expect(beacon).toContain('- Source: `read_source_file(path="src/engine/scheduler.ts", start_line=10, end_line=45)`');
    });

    it('别名 buildProvenanceBeacon 与 projectProvenanceBeacon 完全等价', () => {
      const md = 'Test `runRead`.';
      expect(buildProvenanceBeacon({ content: md })).toBe(projectProvenanceBeacon({ content: md }));
    });
  });

  describe('runRead 端到端注入校验', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('模式 A（分节读取）末尾成功注入 Provenance Beacon', async () => {
      prismaMock.documentChunk.findMany.mockResolvedValue([
        {
          heading: 'Core Flow',
          headingPath: 'Core Flow',
          content: 'Implementation calls `startWorker` in `src/worker.ts`.',
          semVerLabel: null,
        },
      ]);

      const res = await runRead({ target: 'docs/guide.md#Core Flow' }, createRuntime(false));
      const output = textOf(res);

      expect(output).toContain('Implementation calls `startWorker` in `src/worker.ts`.');
      expect(output).toContain('🔍 **Provenance Beacon (L2 Ground Truth · sha-123)**');
      expect(output).toContain('- Symbol: `read_symbol(symbol="startWorker")`');
      expect(output).toContain('- Source: `read_source_file(path="src/worker.ts")`');
    });

    it('模式 B（全篇读取）末尾成功注入 Provenance Beacon', async () => {
      prismaMock.document.findFirst.mockResolvedValue({
        content: '# Full Guide\n\nOverview of `EngineCore` located in `src/core.ts`.\n',
        contentId: null,
        contentRef: null,
      });

      const res = await runRead({ target: 'docs/guide.md' }, createRuntime(false));
      const output = textOf(res);

      expect(output).toContain('Overview of `EngineCore` located in `src/core.ts`.');
      expect(output).toContain('🔍 **Provenance Beacon (L2 Ground Truth · sha-123)**');
      expect(output).toContain('- Symbol: `read_symbol(symbol="EngineCore")`');
      expect(output).toContain('- Source: `read_source_file(path="src/core.ts")`');
    });
  });
});
