import { test, expect, describe, it } from 'vitest';
import { estimateTokens, truncateToTokenBudget, summarizeDocChunk } from '@/lib/token-counter';
import { truncateCognitiveBudget } from '@/lib/agent/semantic-truncator';
import { formatHighDensityDocContext } from '@/lib/agent/context-formatter';
import { ChunkSearchResult } from '@/lib/mcp/doc-search';

describe('token-counter & semantic-truncator & context-formatter', () => {
  test('estimateTokens & truncateToTokenBudget: 系数单调性、边界、栅栏/注释闭合与 emoji 代理对安全', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中文')).toBe(3);
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)));

    expect(truncateToTokenBudget('short text', 100)).toBe('short text');
    expect(truncateToTokenBudget('anything', 0)).toBe('');
    expect(truncateToTokenBudget('anything', NaN)).toBe('');

    const longOut = truncateToTokenBudget('段落内容。'.repeat(500), 200);
    expect(longOut).toContain('Content truncated');
    expect(estimateTokens(longOut)).toBeLessThanOrEqual(230);

    const fenceOut = truncateToTokenBudget('```ts\nconst a = 1;\n' + 'x'.repeat(2000), 50);
    expect(((fenceOut.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || []).length) % 2).toBe(0);
    expect(truncateToTokenBudget('<!-- ' + 'y'.repeat(2000), 30)).toContain('-->');

    const emojiOut = truncateToTokenBudget('🎉'.repeat(10) + 'z'.repeat(1000), 40);
    for (const ch of emojiOut) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  test('summarizeDocChunk: 短文本透传、代码块上限 2、无代码块走 token 截断', () => {
    expect(summarizeDocChunk('短内容')).toBe('短内容');
    const long = [
      '这是开头的叙述部分，解释本章要讲解的核心机制与学习目标。'.repeat(10),
      '```ts\nconst a = 1;\n```',
      '```python\nprint(1)\n```',
      '```bash\necho 3\n```',
      '结尾叙述。',
    ].join('\n\n');
    const summary = summarizeDocChunk(long, 50);
    expect(summary).toContain('**Key Code Sample:**');
    expect(summary).toContain('const a = 1;');
    expect(summary).toContain('print(1)');
    expect(summary).not.toContain('echo 3');

    expect(summarizeDocChunk('纯叙述内容。'.repeat(300), 30)).toContain('Summary truncated');
  });

  it('truncateCognitiveBudget: 预算内/非法预算/段落优先切分/emoji 代理对安全', () => {
    expect(truncateCognitiveBudget('简短内容', { maxTokens: 100 })).toMatchObject({ truncated: false, text: '简短内容', closedFences: [] });
    expect(truncateCognitiveBudget('', { maxTokens: 50 }).text).toBe('');
    expect(truncateCognitiveBudget('text', { maxTokens: 0 }).text).toBe('');
    expect(truncateCognitiveBudget('text', { maxTokens: -1 }).text).toBe('');

    const paraRes = truncateCognitiveBudget(
      ['这是第一段详细描述，包含重要的背景事实。', '', '这是第二段核心要点，讲解主要的设计架构与权衡。', '', '第三段' + '补充文本。'.repeat(100)].join('\n'),
      { maxTokens: 40 }
    );
    expect(paraRes.truncated).toBe(true);
    expect(paraRes.text).toContain('这是第一段详细描述');
    expect(paraRes.finalTokens).toBeLessThanOrEqual(50);

    const emojiRes = truncateCognitiveBudget('🚀🔥🎉✨'.repeat(20) + '文字'.repeat(100), { maxTokens: 25 });
    for (const ch of emojiRes.text) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('truncateCognitiveBudget: 未闭合 ``` / ~~~ / 行内反引号 / HTML 注释自愈闭合', () => {
    const btRes = truncateCognitiveBudget(['```typescript', 'export function f(s: string) {', ...Array(6).fill('  const x = s.trim();'), '}'].join('\n'), { maxTokens: 25 });
    expect(btRes.closedFences).toContain('```');
    expect(((btRes.text.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || []).length) % 2).toBe(0);

    const tildeRes = truncateCognitiveBudget('启动服务：\n~~~bash\nnpm install\nnpm run build\nnpm run start', { maxTokens: 15 });
    expect(tildeRes.closedFences).toContain('~~~');
    expect(((tildeRes.text.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || []).length) % 2).toBe(0);

    const inlineRes = truncateCognitiveBudget('在 JavaScript 中调用 `const result = compute()', { maxChars: 30 });
    expect(((inlineRes.text.replace(/`{2,}/g, '').match(/`/g) || []).length) % 2).toBe(0);

    expect(truncateCognitiveBudget('段落一 <!-- ' + '说明'.repeat(100), { maxTokens: 20 }).text).toContain('-->');
  });

  it('formatHighDensityDocContext: ANCHOR/SCORE 格式化、梯形预算熔断、代码块闭合与多语言锚点', () => {
    expect(formatHighDensityDocContext([])).toBe('');
    expect(formatHighDensityDocContext(null as any)).toBe('');

    const sampleDocs: ChunkSearchResult[] = [
      { id: 'c1', path: 'docs/getting-started.md', heading: 'Installation', headingPath: 'docs/getting-started.md#Installation', title: 'Quickstart Guide', similarity: 0.942, content: '```bash\nnpm install my-lib\n```' },
      { id: 'c2', path: 'docs/architecture/flow.md', heading: 'Event Lifecycle', headingPath: null, title: 'Architecture Overview', similarity: 0.835, content: '事件生命周期由流式网关调度。'.repeat(20) },
      { id: 'c3', path: 'docs/api/client.md', heading: 'Client SDK', headingPath: null, title: 'API Reference', similarity: 0.71, content: '客户端 SDK 参数定义。'.repeat(50) },
    ];
    const single = formatHighDensityDocContext(sampleDocs.slice(0, 1), { owner: 'acme', repo: 'widget' });
    expect(single).toContain('[ANCHOR: docs/getting-started.md#Installation | SCORE: 94%] Quickstart Guide');
    expect(single).toContain('URL: /docs/acme/widget/getting-started#installation');

    const budgeted = formatHighDensityDocContext(sampleDocs, { owner: 'org', repo: 'repo', totalTokenBudget: 150 });
    expect(estimateTokens(budgeted)).toBeLessThanOrEqual(175);

    const tiny = formatHighDensityDocContext(sampleDocs, { totalTokenBudget: 80 });
    expect(tiny).toContain('Quickstart Guide');
    expect(tiny).not.toContain('API Reference');

    const longCodeFormatted = formatHighDensityDocContext(
      [{ id: 'cl', path: 'docs/code.md', heading: 'Big', headingPath: null, title: 'Big', similarity: 0.99, content: ['```typescript', ...Array(60).fill('  const x = 1;'), '```'].join('\n') }],
      { totalTokenBudget: 100 }
    );
    expect(((longCodeFormatted.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || []).length) % 2).toBe(0);

    const multiLang = formatHighDensityDocContext(
      [
        { id: 'jp', path: 'docs/guide.md', heading: 'クイックスタート・ガイド', headingPath: null, title: 'JP', similarity: 0.95, content: 'jp' },
        { id: 'kr', path: 'docs/intro.md', heading: '시작하기 가이드', headingPath: null, title: 'KR', similarity: 0.9, content: 'kr' },
      ],
      { owner: 'acme', repo: 'repo' }
    );
    expect(multiLang).toContain('URL: /docs/acme/repo/guide#クイックスタート・ガイド');
    expect(multiLang).toContain('URL: /docs/acme/repo/intro#시작하기-가이드');
  });
});
