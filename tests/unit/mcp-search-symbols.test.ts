import { describe, it, expect } from 'vitest';
import { runSearchSymbols } from '@/lib/mcp/tools/symbol';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

describe('MCP search_symbols Tool (Topological AST Symbol Search)', () => {
  const mockRepo = {
    id: 'repo-calc-1',
    owner: 'acme',
    repo: 'calculator',
    branch: 'main',
    gitSha: 'sha-abc-123',
    repoProfile: {
      codeClusters: [
        {
          title: 'Math Core',
          directories: ['src/math'],
          files: ['src/math/calc.ts', 'src/math/types.ts'],
          teachingOrder: 1,
          chapterNo: 1,
          summary: 'Core arithmetic operators',
          cognitive: {
            phase: 'core',
            goldenSymbols: [
              { name: 'add', kind: 'function', file: 'src/math/calc.ts' },
              { name: 'Calculator', kind: 'class', file: 'src/math/calc.ts' },
              { name: 'CalcConfig', kind: 'type', file: 'src/math/types.ts' },
            ],
            callFlow: [
              { caller: 'Calculator.compute', callee: 'add', calleeFile: 'src/math/calc.ts' },
              { caller: 'main', callee: 'Calculator.compute', calleeFile: 'src/math/calc.ts' },
            ],
          },
        },
      ],
    },
    navTree: [
      { type: 'page', title: 'Chapter 1: Arithmetic Core', path: 'ch01-math.md' },
    ],
    documents: [
      { id: 'doc-1', title: 'Chapter 1: Arithmetic Core', path: 'ch01-math.md' },
    ],
  };

  const createRuntime = (repo: any, multiRepo = false): RepoRuntime => ({
    multiRepo,
    resolveRepository: async () => ({
      repository: repo,
      documents: repo.documents || [],
      navTree: repo.navTree || [],
    }),
  });

  it('命中关键字返回模糊检索匹配列表与read_symbol引导', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runSearchSymbols({ query: 'calc' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Symbol Search: "calc" in acme/calculator');
    expect(text).toContain('Calculator` (class)');
    expect(text).toContain('CalcConfig` (type)');
    expect(text).toContain('src/math/calc.ts');
    expect(text).toContain('read_symbol(symbol="Calculator", aspect="contract")');
  });

  it('空 query 返回全量顶层黄金符号作为架构备忘清单', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runSearchSymbols({}, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Top Architectural Symbols in acme/calculator');
    expect(text).toContain('add` (function)');
    expect(text).toContain('Calculator` (class)');
    expect(text).toContain('CalcConfig` (type)');
  });

  it('支持传入 file 参数进行模块级范围过滤', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runSearchSymbols({ query: 'calc', file: 'types.ts' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('CalcConfig` (type)');
    expect(text).not.toContain('Calculator` (class)');
  });

  it('支持 limit 参数截断返回数量', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runSearchSymbols({ limit: 1 }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Found 1');
  });

  it('未命中任何符号时返回友好指引提示', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runSearchSymbols({ query: 'NonExistentXYZ' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('No symbols found matching query "NonExistentXYZ"');
    expect(text).toContain('Call search_symbols without query');
  });

  it('Hub 模式未传 repository 时返回作用域引导错误', async () => {
    const runtime = createRuntime(mockRepo, true);
    const res = await runSearchSymbols({ query: 'add' }, runtime);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"repository" is required');
  });
});
