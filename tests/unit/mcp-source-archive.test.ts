import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WEB_DOC_OWNER } from '@/lib/constants';
import {
  cleanSourcePath,
  detectSourceLanguage,
  extractSymbolSignature,
  readSymbolSourceCode,
  readSourceFileWithFallback,
  setSourceFallbackFetcherForTest,
  clearSourceFallbackCacheForTest,
} from '@/lib/mcp/source-archive';

const readFileLocalMock = vi.fn(async () => null);
vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: (...args: unknown[]) => readFileLocalMock(...(args as [string, string, string, string])),
}));

describe('source-archive 纯函数（Go 镜像对齐）', () => {
  describe('cleanSourcePath', () => {
    it.each([
      ['src/lib/a.ts', 'src/lib/a.ts'],
      ['./src/a.ts', 'src/a.ts'],
      ['  spaced.ts  ', 'spaced.ts'],
    ])('%s → %s', (input, expected) => {
      expect(cleanSourcePath(input)).toBe(expected);
    });

    it.each([['../etc/passwd'], ['/etc/passwd'], ['\\win\\sys'], ['a/../../b.ts'], [''], ['./']])(
      '%s 拒绝',
      (input) => {
        expect(cleanSourcePath(input)).toBeNull();
      }
    );
  });

  describe('detectSourceLanguage', () => {
    it.each([
      ['a.go', 'go'],
      ['a.ts', 'typescript'],
      ['a.py', 'python'],
      ['a.rs', 'rust'],
      ['Makefile', 'text'],
    ])('%s → %s', (input, expected) => {
      expect(detectSourceLanguage(input)).toBe(expected);
    });
  });

  describe('extractSymbolSignature', () => {
    it('类 C 函数：捕获前置注释并截断到首个 { 处', () => {
      const src = ['// Doc comment line.', 'export function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n');
      const sig = extractSymbolSignature(src, 'add', 'typescript');
      expect(sig).toContain('// Doc comment line.');
      expect(sig).toContain('export function add(a: number, b: number): number { ... }');
      expect(sig).not.toContain('return a + b;');
    });

    it('类型声明：捕获到匹配闭合 } 为止', () => {
      const src = ['export interface Config {', '  name: string;', '  level: number;', '}'].join('\n');
      const sig = extractSymbolSignature(src, 'Config', 'typescript');
      expect(sig).toContain('export interface Config {');
      expect(sig).toContain('level: number;');
      expect(sig).toContain('}');
    });

    it('python：行尾冒号即签名结束', () => {
      const src = ['def compute(self, value):', '    return value * 2'].join('\n');
      const sig = extractSymbolSignature(src, 'compute', 'python');
      expect(sig).toContain('def compute(self, value): ...');
      expect(sig).not.toContain('return value * 2');
    });

    it('符号未命中时从首行兜底', () => {
      const sig = extractSymbolSignature('type Foo struct {\n\tX int\n}', 'Bar', 'go');
      expect(sig).toContain('type Foo struct {');
    });
  });

  describe('readSymbolSourceCode 切片窗口规则', () => {
    beforeEach(() => {
      readFileLocalMock.mockReset();
    });

    it('有精确行号区间时直接切片', async () => {
      readFileLocalMock.mockResolvedValue('l1\nl2\nl3\nl4\nl5');
      const out = await readSymbolSourceCode('o', 'r', 'sha', 'f.ts', 'sym', 2, 4);
      expect(out).toBe('l2\nl3\nl4');
    });

    it('无行号时从符号定义行取 40 行窗口', async () => {
      const lines = ['header', 'func sym() {', ...Array.from({ length: 50 }, (_, i) => `body${i}`)];
      readFileLocalMock.mockResolvedValue(lines.join('\n'));
      const out = await readSymbolSourceCode('o', 'r', 'sha', 'f.go', 'sym', 0, 0);
      expect(out.startsWith('func sym() {')).toBe(true);
      expect(out.split('\n')).toHaveLength(40);
    });

    it('≤120 行文件全量返回', async () => {
      readFileLocalMock.mockResolvedValue(Array.from({ length: 120 }, (_, i) => `x${i}`).join('\n'));
      const out = await readSymbolSourceCode('o', 'r', 'sha', 'f.go', '', 0, 0);
      expect(out.split('\n')).toHaveLength(120);
    });

    it('>120 行且无符号命中时截断前 60 行并带标记', async () => {
      readFileLocalMock.mockResolvedValue(Array.from({ length: 500 }, (_, i) => `x${i}`).join('\n'));
      const out = await readSymbolSourceCode('o', 'r', 'sha', 'f.go', 'nosuch', 0, 0);
      expect(out.split('\n')).toHaveLength(62); // 60 行 + 空行 + 截断标记
      expect(out).toContain('// ... [Truncated: specify symbol start_line/end_line for targeted inspection]');
    });

    it('归档未命中返回空串（调用方负责降级）', async () => {
      readFileLocalMock.mockResolvedValue(null);
      const out = await readSymbolSourceCode('o', 'r', 'sha', 'f.go', 'sym', 1, 2);
      expect(out).toBe('');
    });
  });

  describe('readSourceFileWithFallback 不可变上游按需回源', () => {
    beforeEach(() => {
      readFileLocalMock.mockReset();
      readFileLocalMock.mockResolvedValue(null);
      clearSourceFallbackCacheForTest();
    });

    afterEach(() => {
      setSourceFallbackFetcherForTest(null);
      clearSourceFallbackCacheForTest();
    });

    it('本地未命中时按不可变 SHA 回源并缓存（二次调用零 HTTP）', async () => {
      const fetcher = vi.fn(async () => new Response('export const x = 42;\n', { status: 200 }));
      setSourceFallbackFetcherForTest(fetcher);

      const sha = 'abcdef1234567890abcdef1234567890abcdef12';
      const first = await readSourceFileWithFallback('acme', 'demo', [sha, 'main'], 'src/x.ts');
      expect(first).toEqual({ content: 'export const x = 42;\n', usedRef: sha });
      expect(fetcher).toHaveBeenCalledTimes(1);

      const second = await readSourceFileWithFallback('acme', 'demo', [sha, 'main'], 'src/x.ts');
      expect(second).toEqual({ content: 'export const x = 42;\n', usedRef: sha });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('web-doc 虚拟仓跳过远端 GitHub 回源', async () => {
      const fetcher = vi.fn(async () => new Response('should not happen', { status: 200 }));
      setSourceFallbackFetcherForTest(fetcher);

      const res = await readSourceFileWithFallback(WEB_DOC_OWNER, 'docs', ['main'], 'page.md');
      expect(res).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('404 负缓存生效，避免重复击穿上游', async () => {
      const fetcher = vi.fn(async () => new Response('Not Found', { status: 404 }));
      setSourceFallbackFetcherForTest(fetcher);

      const sha = '1234567890abcdef1234567890abcdef12345678';
      expect(await readSourceFileWithFallback('acme', 'demo', [sha], 'missing.ts')).toBeNull();
      expect(await readSourceFileWithFallback('acme', 'demo', [sha], 'missing.ts')).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
