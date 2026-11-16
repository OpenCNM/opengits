import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReadSourceFile } from '@/lib/mcp/tools/source-file';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const readFileLocalMock = vi.fn(async () => null);
vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: (...args: unknown[]) => readFileLocalMock(...(args as [string, string, string, string])),
}));

describe('MCP read_source_file Tool (Raw Archive Read)', () => {
  const mockRepo = {
    id: 'repo-calc-1',
    owner: 'acme',
    repo: 'calculator',
    branch: 'main',
    gitSha: 'sha-abc-123',
  };

  const createRuntime = (repo: any, multiRepo = false): RepoRuntime => ({
    multiRepo,
    resolveRepository: async () => ({
      repository: repo,
      documents: [],
      navTree: [],
    }),
  });

  const fixture = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

  beforeEach(() => {
    readFileLocalMock.mockReset();
    readFileLocalMock.mockResolvedValue(null);
  });

  it('缺少 path 参数时返回错误指引', async () => {
    const res = await runReadSourceFile({}, createRuntime(mockRepo));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"path" is required');
  });

  it('拒绝路径穿越与绝对路径', async () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b.ts', '\\windows\\system32']) {
      const res = await runReadSourceFile({ path: bad }, createRuntime(mockRepo));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid or unsafe file path');
    }
  });

  it('end_line 小于 start_line 时返回参数错误', async () => {
    const res = await runReadSourceFile({ path: 'a.ts', start_line: 5, end_line: 2 }, createRuntime(mockRepo));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('end_line (2) must be >= start_line (5)');
  });

  it('归档命中时输出全文代码块与 ref 归因', async () => {
    readFileLocalMock.mockResolvedValue(fixture);
    const res = await runReadSourceFile({ path: 'src/calc.ts' }, createRuntime(mockRepo));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('# 📄 Source File: `src/calc.ts` [sha-abc-123]');
    expect(text).toContain('```typescript');
    expect(text).toContain('line 10');
  });

  it('行区间切片输出范围标注并裁剪正文', async () => {
    readFileLocalMock.mockResolvedValue(fixture);
    const res = await runReadSourceFile({ path: 'src/calc.ts', start_line: 3, end_line: 5 }, createRuntime(mockRepo));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('(Lines 3–5 of 10)');
    expect(text).toContain('line 3');
    expect(text).toContain('line 5');
    expect(text).not.toContain('line 6');
  });

  it('start_line 超出文件长度时返回显式错误', async () => {
    readFileLocalMock.mockResolvedValue(fixture);
    const res = await runReadSourceFile({ path: 'src/calc.ts', start_line: 99 }, createRuntime(mockRepo));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('exceeds file length (10 lines)');
  });

  it('gitSha 归档未命中时按 branch 兜底重读', async () => {
    readFileLocalMock.mockImplementation(async (_owner: string, _repo: string, ref: string) =>
      ref === 'main' ? fixture : null
    );
    const res = await runReadSourceFile({ path: 'src/calc.ts' }, createRuntime(mockRepo));
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('[main]');
  });

  it('归档整体未命中时返回 isError 与降级指引（失效封闭）', async () => {
    readFileLocalMock.mockResolvedValue(null);
    const res = await runReadSourceFile({ path: 'missing.ts' }, createRuntime(mockRepo));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('File not found in local source archive');
    expect(res.content[0].text).toContain('read_symbol');
  });

  it('Hub 模式未传 repository 时返回作用域引导错误', async () => {
    const res = await runReadSourceFile({ path: 'a.ts' }, createRuntime(mockRepo, true));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"repository" is required');
  });
});
