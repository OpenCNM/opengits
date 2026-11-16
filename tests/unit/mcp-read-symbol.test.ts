import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReadSymbol } from '@/lib/mcp/tools/symbol';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

// 归档直读 mock：默认未命中（磁盘无归档），per-test 可覆写为返回 fixture 源码
const readFileLocalMock = vi.fn(async () => null);
vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: (...args: unknown[]) => readFileLocalMock(...(args as [string, string, string, string])),
}));

describe('MCP read_symbol Tool (AST Code Grounding)', () => {
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

  it('缺少 symbol 参数时优雅返回错误指引', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({}, runtime);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"symbol" is required');
  });

  it('命中黄金符号直出符号元数据与调用方', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({ symbol: 'add' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Code Symbol: `add` (function)');
    expect(text).toContain('src/math/calc.ts');
    expect(text).toContain('Calculator.compute');
    expect(text).toContain('Chapter 1: Math Core');
  });

  it('大小写不敏感匹配符号', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({ symbol: 'CALCULATOR' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Code Symbol: `Calculator` (class)');
    expect(text).toContain('src/math/calc.ts');
  });

  it('支持传入 file 参数进行消歧匹配', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({ symbol: 'CalcConfig', file: 'types.ts' }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Code Symbol: `CalcConfig` (type)');
    expect(text).toContain('src/math/types.ts');
  });

  it('include_callers 为 false 时省略调用方信息', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({ symbol: 'add', include_callers: false }, runtime);
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).not.toContain('Cross-Module Callers');
  });

  it('未命中符号时返回错误及可用黄金符号候选列表', async () => {
    const runtime = createRuntime(mockRepo);
    const res = await runReadSymbol({ symbol: 'nonExistentMethod' }, runtime);
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('Symbol "nonExistentMethod" not found');
    expect(text).toContain('Available golden symbols in this repository:');
    expect(text).toContain('add (src/math/calc.ts)');
    expect(text).toContain('Calculator (src/math/calc.ts)');
  });

  it('Hub 模式未传 repository 时返回作用域引导错误', async () => {
    const runtime = createRuntime(mockRepo, true);
    const res = await runReadSymbol({ symbol: 'add' }, runtime);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"repository" is required');
  });

  describe('3-Tier Cognitive Spectrum (aspect parameter)', () => {
    const fixtureSource = [
      '// Adds two numbers with overflow guard.',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function unusedHelper(): void {',
      '  // never called',
      '}',
    ].join('\n');

    beforeEach(() => {
      readFileLocalMock.mockReset();
      readFileLocalMock.mockResolvedValue(null);
    });

    it('默认 aspect="contract" 输出提取的签名契约（归档命中时）', async () => {
      readFileLocalMock.mockResolvedValue(fixtureSource);
      const runtime = createRuntime(mockRepo);
      const res = await runReadSymbol({ symbol: 'add' }, runtime);
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Type & Interface Contract');
      expect(text).toContain('Contract mode: body omitted');
      // 签名提取：声明行截断到 `{ ... }`，不包含函数体（40 行扫描窗口从定义行起，与 Go 对齐）
      expect(text).toContain('export function add(a: number, b: number): number { ... }');
      expect(text).not.toContain('return a + b;');
    });

    it('aspect="implementation" 输出归档真实源码切片', async () => {
      readFileLocalMock.mockResolvedValue(fixtureSource);
      const runtime = createRuntime(mockRepo);
      const res = await runReadSymbol({ symbol: 'add', aspect: 'implementation' }, runtime);
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Code Symbol: `add` (function)');
      expect(text).toContain('Source Implementation');
      expect(text).toContain('```typescript');
      expect(text).toContain('return a + b;');
    });

    it('归档未命中时降级为磁盘缺失提示而非占位符假代码', async () => {
      readFileLocalMock.mockResolvedValue(null);
      const runtime = createRuntime(mockRepo);
      const res = await runReadSymbol({ symbol: 'add', aspect: 'implementation' }, runtime);
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Source code archive file not found on disk');
      expect(text).not.toContain('// Symbol: add in');
    });

    it('aspect="architecture" 输出架构角色与调用方，完全剔除代码块', async () => {
      readFileLocalMock.mockResolvedValue(fixtureSource);
      const runtime = createRuntime(mockRepo);
      const res = await runReadSymbol({ symbol: 'add', aspect: 'architecture' }, runtime);
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Architecture Role: `add` (function)');
      expect(text).toContain('Architecture mode: implementation code omitted');
      expect(text).not.toContain('### Type & Interface Contract');
      expect(text).not.toContain('### Source Implementation');
      expect(text).not.toContain('```');
    });
  });
});
