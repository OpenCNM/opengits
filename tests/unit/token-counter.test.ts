import { test, expect } from 'vitest';
import { estimateTokens, truncateToTokenBudget, summarizeDocChunk } from '@/lib/token-counter';

test('estimateTokens：空值 0 / CJK 与 ASCII 混合按系数 / 单调性', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcd')).toBe(1); // 4 × 0.25
  expect(estimateTokens('中文')).toBe(3); // 2 × 1.3 → ceil(2.6)
  // CJK 密度越高 token 估计越大（同长度下）
  const cjkHeavy = '中'.repeat(100);
  const asciiHeavy = 'a'.repeat(100);
  expect(estimateTokens(cjkHeavy)).toBeGreaterThan(estimateTokens(asciiHeavy));
});

test('truncateToTokenBudget：预算内原样返回 / 非法预算返回空串', () => {
  expect(truncateToTokenBudget('short text', 100)).toBe('short text');
  expect(truncateToTokenBudget('anything', 0)).toBe('');
  expect(truncateToTokenBudget('anything', NaN)).toBe('');
});

test('truncateToTokenBudget：超预算截断并追加后缀，结果在新预算内', () => {
  const long = '段落内容。'.repeat(500);
  const out = truncateToTokenBudget(long, 200);
  expect(out).toContain('Content truncated');
  expect(estimateTokens(out)).toBeLessThanOrEqual(200 + 30); // 截断微调容差
});

test('truncateToTokenBudget：未闭合代码栅栏获得平衡闭合', () => {
  const unbalanced = '```ts\nconst a = 1;\n' + 'x'.repeat(2000);
  const out = truncateToTokenBudget(unbalanced, 50);
  const fences = out.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || [];
  expect(fences.length % 2).toBe(0);
});

test('truncateToTokenBudget：未闭合 HTML 注释获得闭合', () => {
  const unbalanced = '<!-- ' + 'y'.repeat(2000);
  const out = truncateToTokenBudget(unbalanced, 30);
  expect(out).toContain('-->');
});

test('truncateToTokenBudget：emoji 代理对不被劈开（code-point 切片）', () => {
  const withEmoji = '🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉' + 'z'.repeat(1000);
  const out = truncateToTokenBudget(withEmoji, 40);
  // 截断结果不应包含孤立的高/低代理半区（U+D800–U+DFFF）
  for (const ch of out) {
    const code = ch.codePointAt(0)!;
    expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
  }
});

test('summarizeDocChunk：短内容原样返回；长内容 = 叙述开头 + ≤2 个代码块', () => {
  expect(summarizeDocChunk('短内容')).toBe('短内容');
  const long = [
    '这是开头的叙述部分，解释本章要讲解的核心机制与学习目标。'.repeat(10),
    '```ts\nconst a = 1;\n```',
    '```python\nprint(1)\n```',
    '```bash\necho 3\n```', // 第 3 个代码块应被丢弃（上限 2）
    '结尾叙述。',
  ].join('\n\n');
  const summary = summarizeDocChunk(long, 50);
  expect(summary).toContain('这是开头的叙述部分');
  expect(summary).toContain('**Key Code Sample:**');
  expect(summary).toContain('const a = 1;');
  expect(summary).toContain('print(1)');
  expect(summary).not.toContain('echo 3');
});

test('summarizeDocChunk：无代码块的长内容走 token 截断路径', () => {
  const longNarrative = '纯叙述内容。'.repeat(300);
  const summary = summarizeDocChunk(longNarrative, 30);
  expect(summary).toContain('Summary truncated');
});
