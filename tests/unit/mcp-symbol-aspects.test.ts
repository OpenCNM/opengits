import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReadSymbol } from '@/lib/mcp/tools/symbol';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const sourceArchiveMock = vi.hoisted(() => ({
  readSymbolSourceCode: vi.fn(),
  extractSymbolSignature: vi.fn(),
  detectSourceLanguage: vi.fn(() => 'python'),
}));
vi.mock('@/lib/mcp/source-archive', () => sourceArchiveMock);

const symbolsDriverMock = vi.hoisted(() => ({
  executeSidecarSymbolLookup: vi.fn(),
  executeSidecarSymbolSearch: vi.fn(),
}));
vi.mock('@/engine/symbols-driver', () => symbolsDriverMock);

describe('MCP read_symbol Tool (Aspect Matrix & Cognitive Slicing)', () => {
  const mockRepo = {
    id: 'repo-grad-1',
    owner: 'karpathy',
    repo: 'micrograd',
    branch: 'master',
    gitSha: 'sha-grad-123',
    repoProfile: {
      codeClusters: [
        {
          title: 'Engine Core',
          teachingOrder: 1,
          cognitive: {
            goldenSymbols: [
              { name: 'Value', kind: 'class', file: 'micrograd/engine.py' },
              { name: 'backward', kind: 'method', file: 'micrograd/engine.py' },
            ],
            callFlow: [
              { caller: 'Neuron.call', callee: 'Value.__add__', calleeFile: 'micrograd/engine.py' },
              { caller: 'MLP.zero_grad', callee: 'Value.backward', calleeFile: 'micrograd/engine.py' },
            ],
          },
        },
      ],
    },
    documents: [],
    navTree: [],
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
        documents: [],
        navTree: [],
      };
    },
    listRepositories: async () => [
      {
        owner: repo.owner,
        repo: repo.repo,
        repository: repo,
        documents: [],
        navTree: [],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    symbolsDriverMock.executeSidecarSymbolLookup.mockReset().mockResolvedValue({ ok: false });
    sourceArchiveMock.readSymbolSourceCode.mockReset();
    sourceArchiveMock.extractSymbolSignature.mockReset();
  });

  describe('入参校验与作用域控制', () => {
    it('缺少 symbol 参数时返回错误与引导', async () => {
      const res = await runReadSymbol({}, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Error: "symbol" is required.');
    });

    it('Hub 模式未传 repository 时提示 scopeRequiredError', async () => {
      const res = await runReadSymbol({ symbol: 'Value' }, createRuntime(mockRepo, true));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('"repository" is required on the Hub');
    });

    it('指定不存在的仓库时提示 refNotFoundError', async () => {
      const res = await runReadSymbol({ symbol: 'Value', repository: 'unknown/repo' }, createRuntime(mockRepo, true));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Repository "unknown/repo" not found');
    });

    it('符号未找到时返回错误并列出可选的黄金符号建议', async () => {
      const res = await runReadSymbol({ symbol: 'NonExistent' }, createRuntime());
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      expect(text).toContain('Error: Symbol "NonExistent" not found in karpathy/micrograd.');
      expect(text).toContain('Available golden symbols in this repository:');
      expect(text).toContain('Value (micrograd/engine.py)');
    });
  });

  describe('aspect="contract" 契约切片提取', () => {
    it('提取符号签名，裁剪实现正文以节省 Token', async () => {
      const fullClassCode = [
        'class Value:',
        '    def __init__(self, data, _children=(), _op=""):',
        '        self.data = data',
        '        self.grad = 0',
        '        self._backward = lambda: None',
      ].join('\n');

      sourceArchiveMock.readSymbolSourceCode.mockResolvedValue(fullClassCode);
      sourceArchiveMock.extractSymbolSignature.mockReturnValue('class Value:\n    def __init__(self, data, _children=(), _op="")');

      const res = await runReadSymbol({ symbol: 'Value', aspect: 'contract' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('# 🔍 Code Symbol: `Value` (class)');
      expect(text).toContain('- **File**: `micrograd/engine.py`');
      expect(text).toContain('- **Role**: `Core Contract (核心契约)`');
      expect(text).toContain('### Type & Interface Contract');
      expect(text).toContain('class Value:');
      expect(text).toContain('(Contract mode: body omitted to preserve context tokens');
      expect(sourceArchiveMock.extractSymbolSignature).toHaveBeenCalled();
    });

    it('当源码文件未就绪时给出清晰提示', async () => {
      sourceArchiveMock.readSymbolSourceCode.mockResolvedValue('');

      const res = await runReadSymbol({ symbol: 'Value', aspect: 'contract' }, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('(Source code archive file not found on disk; refer to file path above)');
    });
  });

  describe('aspect="architecture" 架构拓扑感知', () => {
    it('输出跨模块调用者、系统角色与课程归属，省略实现代码', async () => {
      const res = await runReadSymbol({ symbol: 'backward', aspect: 'architecture' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('# 🏛️ Architecture Role: `backward` (method)');
      expect(text).toContain('- **Cross-Module Callers**: MLP.zero_grad');
      expect(text).toContain('- **Curriculum Chapter**: Chapter 1: Engine Core');
      expect(text).toContain('(Architecture mode: implementation code omitted');
      expect(sourceArchiveMock.readSymbolSourceCode).not.toHaveBeenCalled();
    });

    it('include_callers=false 时不输出调用者行', async () => {
      const res = await runReadSymbol(
        { symbol: 'backward', aspect: 'architecture', include_callers: false },
        createRuntime()
      );
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).not.toContain('Cross-Module Callers');
    });
  });

  describe('aspect="implementation" 完整实现直出', () => {
    it('输出完整实现代码段及行号信息', async () => {
      symbolsDriverMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: true,
        symbol: {
          name: 'Value',
          kind: 'class',
          file: 'micrograd/engine.py',
          startLine: 1,
          endLine: 25,
          role: 'core_contract',
          pageRank: 0.12,
          importers: 5,
        },
      });

      const fullCode = 'class Value:\n    pass';
      sourceArchiveMock.readSymbolSourceCode.mockResolvedValue(fullCode);

      const res = await runReadSymbol({ symbol: 'Value', aspect: 'implementation' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('- **File**: `micrograd/engine.py` (Lines 1–25)');
      expect(text).toContain('| **PageRank**: 0.120 | **Importers**: 5');
      expect(text).toContain('### Source Implementation');
      expect(text).toContain('```python\nclass Value:\n    pass\n```');
    });

    it('include_code=false 时不渲染源码块', async () => {
      symbolsDriverMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: true,
        symbol: {
          name: 'Value',
          kind: 'class',
          file: 'micrograd/engine.py',
        },
      });

      const res = await runReadSymbol(
        { symbol: 'Value', aspect: 'implementation', include_code: false },
        createRuntime()
      );
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).not.toContain('### Source Implementation');
    });
  });
});
