import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDissectCode } from '@/lib/mcp/tools/dissect';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const dissectMock = vi.hoisted(() => ({
  executeSidecarDissectAst: vi.fn(),
}));
vi.mock('@/engine/dissect-driver', () => dissectMock);

const sourceArchiveMock = vi.hoisted(() => ({
  readSymbolSourceCode: vi.fn(),
  detectSourceLanguage: vi.fn(() => 'typescript'),
}));
vi.mock('@/lib/mcp/source-archive', () => sourceArchiveMock);

describe('MCP dissect_code Tool (AST Collaboration Diagram)', () => {
  const mockRepo = {
    id: 'repo-1',
    owner: 'acme',
    repo: 'flow',
    branch: 'main',
    gitSha: 'sha-flow-123',
  };

  const createRuntime = (repo: any = mockRepo, multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async () => ({
      owner: repo.owner,
      repo: repo.repo,
      repository: repo,
      documents: [],
      navTree: [],
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dissectMock.executeSidecarDissectAst.mockReset();
    sourceArchiveMock.readSymbolSourceCode.mockReset();
    sourceArchiveMock.detectSourceLanguage.mockReset();
    sourceArchiveMock.detectSourceLanguage.mockReturnValue('typescript');
  });

  it('缺少 path 参数时返回错误与寻径指引', async () => {
    const res = await runDissectCode({}, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error: "path" is required');
  });

  it('多仓 Hub 模式下未传 repository 时提示 scopeRequiredError', async () => {
    const res = await runDissectCode({ path: 'src/index.ts' }, createRuntime(mockRepo, true));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"repository" is required on the Hub');
  });

  it('指定不存在的 repository 时返回 refNotFoundError', async () => {
    const runtime: RepoRuntime = {
      label: 'the Hub',
      multiRepo: true,
      resolveRepository: async () => null,
    };
    const res = await runDissectCode({ repository: 'ghost/missing', path: 'src/index.ts' }, runtime);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found in the Hub');
  });

  it('源文件归档未命中时返回显式错误与 outline 指引', async () => {
    sourceArchiveMock.readSymbolSourceCode.mockResolvedValue('');
    const res = await runDissectCode({ path: 'missing/file.ts' }, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('File not found in local source archive');
  });

  it('切片超过 20,000 字符上限时提示收敛窗口', async () => {
    sourceArchiveMock.readSymbolSourceCode.mockResolvedValue('x'.repeat(20_001));
    const res = await runDissectCode({ path: 'big.ts' }, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('source slice too large for dissection');
    expect(res.content[0].text).toContain('Pass start_line/end_line or symbol to narrow the window');
  });

  it('成功解剖代码并输出 tree-sitter AST tier 的 Mermaid 流程图', async () => {
    sourceArchiveMock.readSymbolSourceCode.mockResolvedValue('function foo() { return 1; }');
    dissectMock.executeSidecarDissectAst.mockResolvedValue({
      mermaidCode: 'flowchart TD\n  N1["foo"] --> N2["return"]',
      isAst: true,
    });

    const res = await runDissectCode({ path: 'src/foo.ts', symbol: 'foo' }, createRuntime());
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('# 🔬 Code Dissection: `src/foo.ts` (symbol: foo)');
    expect(text).toContain('```mermaid\nflowchart TD\n  N1["foo"] --> N2["return"]\n```');
    expect(text).toContain('(AST tier: tree-sitter;');
  });

  it('Sidecar 降级时输出 heuristic fallback 提示', async () => {
    sourceArchiveMock.readSymbolSourceCode.mockResolvedValue('const a = 1;');
    dissectMock.executeSidecarDissectAst.mockResolvedValue({
      mermaidCode: 'flowchart TD\n  N1["const a"]',
      isAst: false,
    });

    const res = await runDissectCode({ path: 'src/a.ts' }, createRuntime());
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('(AST tier: heuristic fallback (approximate);');
  });
});
