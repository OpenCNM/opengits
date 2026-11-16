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

    it.each(maliciousPaths)('坚决拒绝非法穿越路径: "%s"', (badPath) => {
      const cleaned = cleanSourcePath(badPath);
      expect(cleaned).toBeNull();
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

    it.each(legitimatePaths)('安全放行合规相对路径: "%s" -> "%s"', (input, expected) => {
      const cleaned = cleanSourcePath(input);
      expect(cleaned).toBe(expected);
    });
  });

  describe('parseSignatureParams 参数特征提取矩阵 (泛型、高阶函数与多语言)', () => {
    it('正确解析 Python 带有 self/cls 的方法并剔除隐藏实参', () => {
      const pyMethod = 'def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:';
      const parsed = parseSignatureParams(pyMethod, 'python');
      expect(parsed.hasParamSignature).toBe(true);
      expect(parsed.rawParams.length).toBe(3);
      expect(parsed.callerParamCount).toBe(2); // 扣减 self 后为 2
    });

    it('正确解析复杂 TypeScript 泛型及默认参数嵌套', () => {
      const tsFunc = 'function transform<T extends Record<string, any[]>>(items: T, mapper: (k: string, v: any[]) => number = defaultMapper): Result<T> {';
      const parsed = parseSignatureParams(tsFunc, 'typescript');
      expect(parsed.hasParamSignature).toBe(true);
      expect(parsed.rawParams.length).toBe(2);
      expect(parsed.callerParamCount).toBe(2);
      expect(parsed.rawParams[0]).toBe('items: T');
      expect(parsed.rawParams[1]).toContain('mapper: (k: string, v: any[]) => number');
    });

    it('无参数函数特征提取', () => {
      const noArgs = 'func Ping() error';
      const parsed = parseSignatureParams(noArgs, 'go');
      expect(parsed.hasParamSignature).toBe(true);
      expect(parsed.rawParams.length).toBe(0);
      expect(parsed.callerParamCount).toBe(0);
      expect(parsed.returnSection).toBe('error');
    });

    it('无括号的声明不是函数可调用签名', () => {
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

    it('反向否定断言与幻觉防护: 断言不存在的方法', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'Value does not define method batch_eval',
        symbol: 'Value',
        file: 'engine.py',
        signature: 'class Value:',
        sourceCode: pythonClassSource,
        lang: 'python',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('identifier "batch_eval" is not declared');
    });

    it('假肯定断言与幻觉防护: 虚假捏造的方法必须被坚决证伪', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'Value class has method async_predict',
        symbol: 'Value',
        file: 'engine.py',
        signature: 'class Value:',
        sourceCode: pythonClassSource,
        lang: 'python',
      });

      expect(res.verdict).toBe('REFUTED_FALSE');
      expect(res.summary).toContain('identifier "async_predict" is not declared');
    });

    it('真肯定断言: 实际声明的方法确证通过', () => {
      const res = evaluateClaimAgainstEvidence({
        claim: 'Value class defines method backward',
        symbol: 'Value',
        file: 'engine.py',
        signature: 'class Value:',
        sourceCode: pythonClassSource,
        lang: 'python',
      });

      expect(res.verdict).toBe('VERIFIED_TRUE');
      expect(res.summary).toContain('identifier "backward" is declared');
    });
  });
});
