import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseSignatureParams,
  parseFunctionSignature,
  isValidTypeIdentifier,
  evaluateClaimAgainstEvidence,
  runVerifyClaim,
} from '@/lib/mcp/tools/verify-claim';

// ── Mock DB 面 ──
const prismaMock = vi.hoisted(() => ({
  documentChunk: { findMany: vi.fn() },
  document: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

// ── Mock Sidecar & Storage 面 ──
const sidecarMock = vi.hoisted(() => ({
  executeSidecarSymbolLookup: vi.fn(),
  executeSidecarSymbolSearch: vi.fn(),
}));
vi.mock('@/engine/symbols-driver', () => sidecarMock);

const archiveStoreMock = vi.hoisted(() => ({
  readFileLocal: vi.fn(async () => null),
}));
vi.mock('@/engine/tarball/archive-store', () => archiveStoreMock);

const mockRepo = {
  id: 'repo-1',
  owner: 'acme',
  repo: 'auth-service',
  branch: 'main',
  gitSha: '9f8e7d6c5b4a',
  repoProfile: {
    codeClusters: [
      {
        title: 'Authentication Module',
        teachingOrder: 1,
        cognitive: {
          goldenSymbols: [
            {
              name: 'VerifyToken',
              file: 'src/auth/token.go',
              kind: 'function',
              startLine: 10,
              endLine: 25,
            },
          ],
        },
      },
    ],
  },
  documents: [],
  navTree: [],
};

function createRuntime(multiRepo = false) {
  return {
    multiRepo,
    resolveRepository: async (ref?: string) => {
      if (ref && ref !== 'acme/auth-service' && ref !== 'repo-1') return null;
      return {
        owner: 'acme',
        repo: 'auth-service',
        repository: mockRepo,
        documents: [],
        navTree: [],
      };
    },
  } as any;
}

const textOf = (res: any) => (res?.content?.[0]?.text ?? '') as string;

describe('verify_claim (闭环事实测谎仪)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseSignatureParams (参数签名解析器)', () => {
    it('正确解析 Go 函数签名参数列表', () => {
      const sig = 'func VerifyToken(token string, secret string) (*Claims, error)';
      const { rawParams, callerParamCount } = parseSignatureParams(sig, 'go');
      expect(rawParams).toEqual(['token string', 'secret string']);
      expect(callerParamCount).toBe(2);
    });

    it('正确解析 TypeScript 泛型及默认参数', () => {
      const sig = 'function schedule<T>(task: Task<T>, delayMs: number = 0): Promise<T>';
      const { rawParams, callerParamCount } = parseSignatureParams(sig, 'typescript');
      expect(rawParams).toEqual(['task: Task<T>', 'delayMs: number = 0']);
      expect(callerParamCount).toBe(2);
    });

    it('针对 Python 方法剔除 self/cls 计数', () => {
      const sig = 'def execute(self, ctx: Context, force: bool = False) -> None:';
      const { rawParams, callerParamCount } = parseSignatureParams(sig, 'python');
      expect(rawParams.length).toBe(3);
      expect(callerParamCount).toBe(2);
    });

    it('处理无参数或 void 参数', () => {
      expect(parseSignatureParams('func Ping() bool', 'go').callerParamCount).toBe(0);
      expect(parseSignatureParams('function ping(void): void', 'typescript').callerParamCount).toBe(0);
      expect(parseSignatureParams('function ping()', 'typescript').callerParamCount).toBe(0);
    });

    it('正确解析 Go 结构体方法 receiver 并跳过，正确提取实际参数与返回值', () => {
      const sig = 'func (w *WorkerPool) Submit(task Task, priority int) error';
      const { rawParams, callerParamCount, returnSection } = parseSignatureParams(sig, 'go');
      expect(rawParams).toEqual(['task Task', 'priority int']);
      expect(callerParamCount).toBe(2);
      expect(returnSection).toBe('error');

      // 验证 parseFunctionSignature 别名与 parseSignatureParams 行为完全一致
      expect(parseFunctionSignature(sig, 'go')).toEqual(parseSignatureParams(sig, 'go'));
    });

    it('isValidTypeIdentifier 支持 Go 多返回值/元组类型、切片、映射、接口及关键字', () => {
      expect(isValidTypeIdentifier('(*Claims, error)')).toBe(true);
      expect(isValidTypeIdentifier('(int, error)')).toBe(true);
      expect(isValidTypeIdentifier('([]byte, error)')).toBe(true);
      expect(isValidTypeIdentifier('(any, error)')).toBe(true);
      expect(isValidTypeIdentifier('(*Data, error)')).toBe(true);
      expect(isValidTypeIdentifier('string')).toBe(true);
      expect(isValidTypeIdentifier('[]byte')).toBe(true);
      expect(isValidTypeIdentifier('map[string]any')).toBe(true);
      expect(isValidTypeIdentifier('interface{}')).toBe(true);
      expect(isValidTypeIdentifier('any')).toBe(true);
      expect(isValidTypeIdentifier('Result')).toBe(true);
      expect(isValidTypeIdentifier('the parsed claims')).toBe(false);
      expect(isValidTypeIdentifier('a new token')).toBe(false);
      expect(isValidTypeIdentifier('(the parsed claims, error)')).toBe(false);
      // 纯自然语言小写词阻断（防 "returns a value/data/object" 模糊断言误触 REFUTED），
      // 大写形态是合法类型名（Data/Result/Value），any 为 Go/TS 内置类型故放行
      expect(isValidTypeIdentifier('value')).toBe(false);
      expect(isValidTypeIdentifier('data')).toBe(false);
      expect(isValidTypeIdentifier('object')).toBe(false);
      expect(isValidTypeIdentifier('result')).toBe(false);
      expect(isValidTypeIdentifier('success')).toBe(false);
      expect(isValidTypeIdentifier('failure')).toBe(false);
      expect(isValidTypeIdentifier('Data')).toBe(true);
      expect(isValidTypeIdentifier('Value')).toBe(true);
    });

    it('普通高阶 Go 函数（无 receiver）不被误判为结构体方法', () => {
      const sig = 'func Handle(req Request, priority int) func(resp Response)';
      const { rawParams, callerParamCount, returnSection } = parseSignatureParams(sig, 'go');
      expect(rawParams).toEqual(['req Request', 'priority int']);
      expect(callerParamCount).toBe(2);
      expect(returnSection).toBe('func(resp Response)');
    });

    it('函数类型签名（func( 直接开头）返回闭包时不把闭包形参误当本函数实参表', () => {
      const sig = 'func(a, b string) func(c int) int';
      const { rawParams, callerParamCount, returnSection } = parseSignatureParams(sig, 'go');
      expect(rawParams).toEqual(['a', 'b string']);
      expect(callerParamCount).toBe(2);
      expect(returnSection).toBe('func(c int) int');
    });
  });

  describe('evaluateClaimAgainstEvidence (事实评估引擎)', () => {
    const sampleGoSignature = 'func VerifyToken(token string, secret string) (*Claims, error)';
    const sampleGoSource = [
      '// Package auth handles tokens',
      'func VerifyToken(token string, secret string) (*Claims, error) {',
      '\tif token == "" {',
      '\t\treturn nil, errors.New("empty token")',
      '\t}',
      '\treturn parseJWT(token, secret)',
      '}',
    ].join('\n');

    it('参数个数断言一致时判为 VERIFIED_TRUE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken takes 2 arguments',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('2 parameter(s)');
    });

    it('中文参数个数断言一致时判为 VERIFIED_TRUE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken 接收两个参数',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('2 parameter(s)');
    });

    it('参数个数断言失真时判为 REFUTED_FALSE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken takes 3 arguments',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('Claim incorrectly asserts 3 parameter(s)');
      expect(res.summary).toContain('shows 2 parameter(s)');
    });

    it('参数个数断言包含 10/20 等以 0 结尾的多位数时不误判为 0 参数 (防边界吞字)', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken taking 10 parameters',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('Claim incorrectly asserts 10 parameter(s)');
      expect(res.summary).toContain('shows 2 parameter(s)');
    });

    it('类声明等无形参括号符号断言成员方法时，参数规则不误拦，准确判为 REFUTED_FALSE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'Value class has an async batch_forward method taking 10 parameters',
        symbol: 'Value',
        file: 'micrograd/engine.py',
        signature: 'class Value:',
        sourceCode: 'class Value:\n  def backward(self):\n    pass\n',
        lang: 'python',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('identifier "batch_forward" is not declared');
    });

    it('返回值包含 error 断言时判为 VERIFIED_TRUE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken returns an error on invalid token',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('matches assertion "error"');
    });

    it('返回值断言与实际返回冲突时判为 REFUTED_FALSE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken returns string',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('Claim asserts return type "string"');
    });

    it('自然语言返回值断言（如 returns the parsed claims）命中核心类型词时判为 VERIFIED_TRUE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken returns the parsed claims on success',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('Claim verified');
    });

    it('自然语言非语法类型短语未命中时降级为 AMBIGUOUS，绝不伪造 REFUTED_FALSE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken returns some complex data',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('AMBIGUOUS');
    });

    it('否定存在性断言（如 does not exist）在物理符号存在时正确判伪 (REFUTED_FALSE)', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken does not exist in the v2 codebase anymore',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('Claim asserts symbol "VerifyToken" does not exist, but it is physically defined');
    });

    it('参数匹配使用单词边界，防止 "id" 误命中 "userId"', () => {
      const sigWithUserId = 'func GetUser(userId string) *User';
      const res = evaluateClaimAgainstEvidence({
        claim: 'GetUser takes id parameter',
        symbol: 'GetUser',
        file: 'src/user.go',
        signature: sigWithUserId,
        sourceCode: 'func GetUser(userId string) *User { return nil }',
        lang: 'go',
      });

      // "id" 不应误匹配 "userId"，由于未命中参数且非确定性断言，降级为 AMBIGUOUS
      expect(res.verdict).toBe('AMBIGUOUS');
    });

    it('特定代码字面量包含验证判为 VERIFIED_TRUE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken rejects with "empty token" when token is blank',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('empty token');
    });

    it('纯运行时复杂行为断言降级为 AMBIGUOUS 并附带源码证据', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken is thread-safe and never causes CPU spikes under heavy concurrent load',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: sampleGoSignature,
        sourceCode: sampleGoSource,
        lang: 'go',
      });

      expect(res.verdict).toBe('AMBIGUOUS');
      expect(res.summary).toContain('cannot be conclusively determined by signature alone');
    });
  });

  describe('runVerifyClaim (端到端 MCP 工具调用)', () => {
    it('缺少 claim 参数时返回错误', async () => {
      const res = await runVerifyClaim({ claim: '' }, createRuntime(false));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Error: "claim" is required');
    });

    it('缺少 symbol 与 file 参数且无法从 claim 推导时返回错误', async () => {
      const res = await runVerifyClaim({ claim: 'It should work seamlessly' }, createRuntime(false));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('At least one of "symbol" or "file" is required');
    });

    it('符号在 AST 索引与仓库均不存在时直接返回 REFUTED_FALSE 结论', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: false,
        symbol: null,
      });

      const res = await runVerifyClaim(
        { claim: 'NonExistentFunc exists', symbol: 'NonExistentFunc' },
        createRuntime(false)
      );

      expect(res.isError).toBeFalsy();
      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `REFUTED_FALSE`');
      expect(output).toContain('Symbol "NonExistentFunc" does not exist');
    });

    it('否定存在断言且符号确不存在时返回 VERIFIED_TRUE', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: false,
        symbol: null,
      });

      const res = await runVerifyClaim(
        { claim: 'DeprecatedFunc does not exist in the codebase', symbol: 'DeprecatedFunc' },
        createRuntime(false)
      );

      expect(res.isError).toBeFalsy();
      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `VERIFIED_TRUE`');
      expect(output).toContain('Claim confirmed: symbol "DeprecatedFunc" does not exist');
    });

    it('Sidecar 宕机或异常时（ok: false）失效封闭降级为 AMBIGUOUS，绝不伪造 REFUTED_FALSE', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: false,
        found: false,
        error: 'sidecar connection refused (ECONNREFUSED 127.0.0.1:8082)',
      });

      const res = await runVerifyClaim(
        { claim: 'CriticalSymbol exists', symbol: 'CriticalSymbol' },
        createRuntime(false)
      );

      expect(res.isError).toBeFalsy();
      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `AMBIGUOUS`');
      expect(output).toContain('Physical AST symbol lookup service was unreachable or errored');
      expect(output).not.toContain('`REFUTED_FALSE`');
    });

    it('端到端核验：从 AST 与归档读取切片并确证断言 (VERIFIED_TRUE)', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: true,
        symbol: {
          name: 'VerifyToken',
          file: 'src/auth/token.go',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          role: 'core_contract',
          pageRank: 0.1,
          importers: 2,
          callers: ['HandleLogin'],
        },
      });

      archiveStoreMock.readFileLocal.mockResolvedValue(
        'package auth\n\nfunc VerifyToken(token string, secret string) (*Claims, error) {\n\treturn nil, nil\n}'
      );

      const res = await runVerifyClaim(
        {
          claim: 'VerifyToken accepts 2 arguments',
          symbol: 'VerifyToken',
          file: 'src/auth/token.go',
        },
        createRuntime(false)
      );

      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `VERIFIED_TRUE`');
      expect(output).toContain('Physical Evidence (L2 Ground Truth · 9f8e7d6)');
      expect(output).toContain('func VerifyToken(token string, secret string) (*Claims, error)');
    });

    it('多仓 Hub 模式下未传 repository 时提示错误', async () => {
      const res = await runVerifyClaim(
        { claim: 'VerifyToken takes 2 arguments', symbol: 'VerifyToken' },
        createRuntime(true)
      );

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('"repository" is required');
    });

    it('对不存在的符号做非存在性否定断言时判为 REFUTED_FALSE，绝不因包含 not 误判为 VERIFIED_TRUE', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: false,
        symbol: null,
      });

      const res = await runVerifyClaim(
        { claim: 'MissingFunc does not return an error on failure', symbol: 'MissingFunc' },
        createRuntime(false)
      );

      expect(res.isError).toBeFalsy();
      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `REFUTED_FALSE`');
      expect(output).toContain('Symbol "MissingFunc" does not exist in physical AST index');
    });

    it('对 Go 结构体方法存在性断言，能识别结构体体外的独立方法声明', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: true,
        symbol: {
          name: 'WorkerPool',
          file: 'src/pool.go',
          startLine: 1,
          endLine: 5,
          kind: 'type',
          role: 'core_contract',
          pageRank: 0.1,
          importers: 1,
          callers: [],
        },
      });

      // 模拟文件内容：struct 定义在 1-5 行，Stop 方法定义在 10-15 行（struct 体外）
      archiveStoreMock.readFileLocal.mockResolvedValue(
        `package pool\n\ntype WorkerPool struct {\n\tclosed bool\n}\n\nfunc (w *WorkerPool) Stop() error {\n\treturn nil\n}`
      );

      const res = await runVerifyClaim(
        {
          claim: 'WorkerPool has method Stop',
          symbol: 'WorkerPool',
          file: 'src/pool.go',
        },
        createRuntime(false)
      );

      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `VERIFIED_TRUE`');
      expect(output).toContain('identifier "Stop" is declared');
    });

    it('返回值元组断言 (*Claims, error) 精确匹配', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'VerifyToken returns (*Claims, error)',
        symbol: 'VerifyToken',
        file: 'src/auth/token.go',
        signature: 'func VerifyToken(token string) (*Claims, error)',
        sourceCode: 'func VerifyToken(token string) (*Claims, error) { return nil, nil }',
        lang: 'go',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('matches assertion "(*Claims, error)"');
    });

    it('模糊自然语言返回值断言（returns a value）不下达 REFUTED，穿透为 AMBIGUOUS', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'fetchData returns a value',
        symbol: 'fetchData',
        file: 'src/fetch.go',
        signature: 'func fetchData() ([]byte, error)',
        sourceCode: 'func fetchData() ([]byte, error) { return nil, nil }',
        lang: 'go',
      });

      expect(res.verdict).toBe('AMBIGUOUS');
    });

    it('Go 结构体切片未包含某方法时，否定断言应降级为 AMBIGUOUS，不可直接断言无此方法', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'WorkerPool does not have method Close',
        symbol: 'WorkerPool',
        file: 'src/pool.go',
        signature: 'type WorkerPool struct',
        sourceCode: 'type WorkerPool struct {\n\tclosed bool\n}',
        lang: 'go',
      });

      expect(res.verdict).toBe('AMBIGUOUS');
      expect(res.summary).toContain('In Go, methods are declared outside struct bodies');
    });

    it('TypeScript 类未包含某成员方法时，肯定断言确切判为 REFUTED_FALSE', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'WorkerPool has method nonExistent',
        symbol: 'WorkerPool',
        file: 'src/pool.ts',
        signature: 'class WorkerPool',
        sourceCode: 'class WorkerPool {\n  stop(): void {}\n}',
        lang: 'typescript',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('identifier "nonExistent" is not declared');
    });

    it('对不存在的符号做包含 declared / 声明 的否定断言时确证为 VERIFIED_TRUE', async () => {
      sidecarMock.executeSidecarSymbolLookup.mockResolvedValue({
        ok: true,
        found: false,
        symbol: null,
      });

      const res = await runVerifyClaim(
        { claim: 'GhostSymbol is not declared in the codebase', symbol: 'GhostSymbol' },
        createRuntime(false)
      );

      expect(res.isError).toBeFalsy();
      const output = textOf(res);
      expect(output).toContain('# ⚖️ Claim Verification: `VERIFIED_TRUE`');
      expect(output).toContain('Claim confirmed: symbol "GhostSymbol" does not exist in physical AST index');
    });
  });
});
