import { describe, it, expect } from 'vitest';
import { cleanSourcePath } from '@/lib/mcp/source-archive';
import {
  parseSignatureParams,
  isValidTypeIdentifier,
  evaluateClaimAgainstEvidence,
} from '@/lib/mcp/tools/verify-claim';

describe('MCP Adversarial & Fuzzing Matrix (对抗性模糊测试网)', () => {
  describe('cleanSourcePath 路径穿越对抗矩阵 (30+ 攻击向量)', () => {
    const maliciousPaths = [
      '../etc/passwd',
      '../../secret.key',
      '..\\windows\\system32',
      '/etc/shadow',
      '/root/.ssh/id_rsa',
      '\\Windows\\System32\\cmd.exe',
      'C:\\autoexec.bat',
      'D:/data.db',
      'src/../../etc/passwd',
      'foo/bar/../../../baz',
      '..',
      '../',
      '..\\',
      './../foo',
      'foo/..',
      'foo/../',
      'foo/bar/..',
      ' /etc/passwd',
      '\\unc\\server\\share',
      '\\\\127.0.0.1\\c$',
      'foo/..\\bar',
      'foo/bar/..\\..\\baz',
      '',
      '   ',
    ];

    it('坚决拒绝全部 24 个非法穿越路径向量', () => {
      for (const badPath of maliciousPaths) {
        expect(cleanSourcePath(badPath), badPath).toBeNull();
      }
    });

    const legitimatePaths = [
      ['src/index.ts', 'src/index.ts'],
      ['./src/index.ts', 'src/index.ts'],
      ['internal/auth/token.go', 'internal/auth/token.go'],
      ['./internal/auth/token.go', 'internal/auth/token.go'],
      ['README.md', 'README.md'],
      ['./README.md', 'README.md'],
      ['pkg/sub_dir-1/file.test.js', 'pkg/sub_dir-1/file.test.js'],
      ['deep/nested/folder/structure/module.py', 'deep/nested/folder/structure/module.py'],
    ];

    it('安全放行全部合规相对路径并规范化 ./ 前缀', () => {
      for (const [input, expected] of legitimatePaths) {
        expect(cleanSourcePath(input), input).toBe(expected);
      }
    });
  });

  describe('parseSignatureParams 参数特征提取矩阵 (泛型、高阶函数与多语言)', () => {
    it('解析 Python self/cls、TS 泛型默认参数、Go 无参及非函数声明', () => {
      const pyMethod = 'def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:';
      const parsedPy = parseSignatureParams(pyMethod, 'python');
      expect(parsedPy.hasParamSignature).toBe(true);
      expect(parsedPy.rawParams.length).toBe(3);
      expect(parsedPy.callerParamCount).toBe(2);

      const tsFunc = 'function transform<T extends Record<string, any[]>>(items: T, mapper: (k: string, v: any[]) => number = defaultMapper): Result<T> {';
      const parsedTs = parseSignatureParams(tsFunc, 'typescript');
      expect(parsedTs.hasParamSignature).toBe(true);
      expect(parsedTs.rawParams.length).toBe(2);
      expect(parsedTs.callerParamCount).toBe(2);
      expect(parsedTs.rawParams[0]).toBe('items: T');
      expect(parsedTs.rawParams[1]).toContain('mapper: (k: string, v: any[]) => number');

      const parsedGo = parseSignatureParams('func Ping() error', 'go');
      expect(parsedGo.hasParamSignature).toBe(true);
      expect(parsedGo.rawParams.length).toBe(0);
      expect(parsedGo.callerParamCount).toBe(0);
      expect(parsedGo.returnSection).toBe('error');

      for (const nonCallable of ['class Foo:', 'type ID = string', 'interface Bar {', 'const MAX = 100']) {
        const parsed = parseSignatureParams(nonCallable);
        expect(parsed.hasParamSignature).toBe(false);
        expect(parsed.rawParams.length).toBe(0);
      }
    });
  });

  describe('evaluateClaimAgainstEvidence 对抗性测谎用例网', () => {
    const pythonClassSource = [
      'class Value:',
      '    def __init__(self, data, _children=(), _op=""):',
      '        self.data = data',
      '        self.grad = 0',
      '    def backward(self):',
      '        pass',
      '    def __add__(self, other):',
      '        pass',
    ].join('\n');

    const goFuncSource = [
      'func ExecutePipeline(ctx context.Context, tasks []Task, maxWorkers int) (int, error) {',
      '    return 0, nil',
      '}',
    ].join('\n');

    it('参数数量断言抗子串吞字矩阵: 0..20 数字与词汇边界', () => {
      const countsToTest = [
        ['10', 10],
        ['20', 20],
        ['11', 11],
        ['0', 0],
        ['ten', 10],
        ['no', 0],
      ] as const;

      for (const [token, count] of countsToTest) {
        const res = evaluateClaimAgainstEvidence({
          claim: `ExecutePipeline requires ${token} arguments`,
          symbol: 'ExecutePipeline',
          signature: 'func ExecutePipeline(ctx context.Context, tasks []Task, maxWorkers int) (int, error)',
          sourceCode: goFuncSource,
          lang: 'go',
        });

        if (count === 3) {
          expect(res.verdict).toBe('VERIFIED_TRUE');
        } else {
          expect(res.verdict).toBe('REFUTED_FALSE');
          expect(res.summary).toContain(`Claim incorrectly asserts ${count} parameter(s)`);
          expect(res.summary).toContain('shows 3 parameter(s)');
        }
      }
    });

    it('identifier 肯定/否定幻觉防护：真声明通过、不存在证伪、否定存在证真', () => {
      const cases = [
        {
          claim: 'Value does not define method batch_eval',
          verdict: 'VERIFIED_TRUE',
          substr: 'identifier "batch_eval" is not declared',
        },
        {
          claim: 'Value class has method async_predict',
          verdict: 'REFUTED_FALSE',
          substr: 'identifier "async_predict" is not declared',
        },
        {
          claim: 'Value class defines method backward',
          verdict: 'VERIFIED_TRUE',
          substr: 'identifier "backward" is declared',
        },
      ] as const;

      for (const tc of cases) {
        const res = evaluateClaimAgainstEvidence({
          claim: tc.claim,
          symbol: 'Value',
          file: 'engine.py',
          signature: 'class Value:',
          sourceCode: pythonClassSource,
          lang: 'python',
        });
        expect(res.verdict).toBe(tc.verdict);
        expect(res.summary).toContain(tc.substr);
      }
    });
  });
});
