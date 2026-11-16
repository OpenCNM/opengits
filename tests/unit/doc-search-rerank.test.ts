import { test, expect } from 'vitest';
import { rerankChunkResults, buildLocatorSnippet } from '@/lib/mcp/doc-search';

function chunk(overrides: Partial<Record<string, any>> = {}): any {
  return {
    similarity: 0.5,
    heading: '',
    title: '',
    content: '',
    path: 'docs/a.md',
    ...overrides,
  };
}

// ── rerankChunkResults：反「高频概述 chunk 霸榜」重排 ──

test('精确短语命中 heading/title → +0.3 压过纯内容命中（+0.15）', () => {
  const results = [
    chunk({ similarity: 0.7, content: 'contains server actions deep inside', path: 'docs/z-overview.md' }), // 0.7+0.15=0.85
    chunk({ similarity: 0.6, heading: 'Server Actions', path: 'docs/a-target.md' }), // 0.6+0.3=0.9
  ];
  const ranked = rerankChunkResults(results, 'server actions');
  expect(ranked[0].path).toBe('docs/a-target.md');
});

test('关键词命中 heading/title → +0.1×≤2 加成，压过同分无命中', () => {
  const results = [
    chunk({ similarity: 0.6, path: 'docs/x.md' }),
    chunk({ similarity: 0.55, heading: 'useEffect 生命周期', path: 'docs/y.md' }),
  ];
  const ranked = rerankChunkResults(results, 'useEffect 生命周期');
  expect(ranked[0].path).toBe('docs/y.md');
});

test('同分 tiebreak：path 字典序升序（确定性输出）', () => {
  const results = [
    chunk({ path: 'docs/b.md' }),
    chunk({ path: 'docs/a.md' }),
    chunk({ path: 'docs/c.md' }),
  ];
  const ranked = rerankChunkResults(results, '随便');
  expect(ranked.map((r: any) => r.path)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
});

test('短列表/空查询直接透传（不重排）', () => {
  const single = [chunk()];
  expect(rerankChunkResults(single, 'anything')).toBe(single); // ≤1 结果原引用返回
  const pair = [chunk({ path: 'b.md' }), chunk({ path: 'a.md' })];
  expect(rerankChunkResults(pair, '   ')).toEqual(pair);
  expect(rerankChunkResults(pair, '!!!')).toEqual(pair); // 关键词提取为空
});

// ── buildLocatorSnippet：确定性的关键词中心窗口 ──

test('最长命中关键词居中，前后省略号（半径 120 之外裁切）', () => {
  const content = 'x'.repeat(400) + 'abcdefg' + 'y'.repeat(400);
  const snippet = buildLocatorSnippet(content, ['zzz', 'abcdefg']);
  expect(snippet.startsWith('...')).toBe(true);
  expect(snippet.endsWith('...')).toBe(true);
  expect(snippet).toContain('abcdefg');
});

test('无命中 → 从头截取；空白折叠为单空格', () => {
  expect(buildLocatorSnippet('plain start text', ['nomatch'])).toContain('plain start');
  expect(buildLocatorSnippet('a\n\n  b\tc keyword', ['keyword'])).not.toMatch(/\s{2,}/);
});

test('空内容返回空串', () => {
  expect(buildLocatorSnippet('', ['x'])).toBe('');
});

test('🧪 [7.12.1.3 · HIGH] locatorScore 与 rerankChunkResults 优先消费 snippet，即使 content 为空也能完成关键词加权', () => {
  const results = [
    chunk({ similarity: 0.5, content: '', snippet: 'contains server actions snippet', path: 'docs/z.md' }),
    chunk({ similarity: 0.5, content: '', snippet: 'no match snippet', path: 'docs/a.md' }),
  ];
  const ranked = rerankChunkResults(results, 'server actions');
  expect(ranked[0].path).toBe('docs/z.md');
});

