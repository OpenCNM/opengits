import { describe, it, expect } from 'vitest';
import {
  formatHighDensityDocContext,
  DEFAULT_CONTEXT_TOTAL_TOKEN_BUDGET,
} from '@/lib/agent/context-formatter';
import { ChunkSearchResult } from '@/lib/mcp/doc-search';
import { estimateTokens } from '@/lib/token-counter';

describe('formatHighDensityDocContext: 高密度 CDC 上下文注入与预算控制', () => {
  const sampleDocs: ChunkSearchResult[] = [
    {
      id: 'chunk-1',
      path: 'docs/getting-started.md',
      heading: 'Installation',
      headingPath: 'docs/getting-started.md#Installation',
      title: 'Quickstart Guide',
      similarity: 0.942,
      content: [
        '安装依赖并配置环境：',
        '```bash',
        'npm install my-lib',
        'export API_KEY=xxx',
        '```',
        '运行第一条命令以初始化。',
      ].join('\n'),
    },
    {
      id: 'chunk-2',
      path: 'docs/architecture/flow.md',
      heading: 'Event Lifecycle',
      headingPath: null,
      title: 'Architecture Overview',
      similarity: 0.835,
      content: '事件生命周期由 In-Band 流式处理网关统一调度，支持跨截面对偶账本。'.repeat(20),
    },
    {
      id: 'chunk-3',
      path: 'docs/api/client.md',
      heading: 'Client SDK',
      headingPath: null,
      title: 'API Reference',
      similarity: 0.71,
      content: '详细的客户端 SDK 参数定义与类型声明。'.repeat(50),
    },
  ];

  it('空输入安全返回空串', () => {
    expect(formatHighDensityDocContext([])).toBe('');
    expect(formatHighDensityDocContext(null as any)).toBe('');
  });

  it('标准输出格式包含 ANCHOR 标头、SCORE 百分比与可点击 Web URL', () => {
    const formatted = formatHighDensityDocContext(sampleDocs.slice(0, 1), {
      owner: 'acme',
      repo: 'widget',
    });

    expect(formatted).toContain('=== RELEVANT TUTORIAL DOCS ===');
    expect(formatted).toContain('[ANCHOR: docs/getting-started.md#Installation | SCORE: 94%] Quickstart Guide');
    expect(formatted).toContain('URL: /docs/acme/widget/getting-started#installation');
    expect(formatted).toContain('```bash\nnpm install my-lib');
  });

  it('多文档梯形预算控制：总 Token 消耗被严格约束在 totalTokenBudget 内', () => {
    const smallBudget = 150;
    const formatted = formatHighDensityDocContext(sampleDocs, {
      owner: 'org',
      repo: 'repo',
      totalTokenBudget: smallBudget,
    });

    const totalTokens = estimateTokens(formatted);
    // 必须在总预算上限内（允许微小自愈容差）
    expect(totalTokens).toBeLessThanOrEqual(smallBudget + 25);
  });

  it('超出总预算时优雅熔断停止后续低分文档，杜绝上下文污染', () => {
    // 预算仅够容纳 1 篇文档
    const tinyBudget = 80;
    const formatted = formatHighDensityDocContext(sampleDocs, {
      totalTokenBudget: tinyBudget,
    });

    // 应该只包含第一篇高分文档，未包含第三篇低分文档
    expect(formatted).toContain('Quickstart Guide');
    expect(formatted).not.toContain('API Reference');
  });

  it('单条文档被截断时，内部代码块 100% 自动闭合', () => {
    const docWithLongCode: ChunkSearchResult[] = [
      {
        id: 'chunk-long',
        path: 'docs/code.md',
        heading: 'Big Function',
        headingPath: null,
        title: 'Big Code',
        similarity: 0.99,
        content: [
          '```typescript',
          'export function largeCode() {',
          ...Array(60).fill('  const step = calculate();'),
          '}',
          '```',
        ].join('\n'),
      },
    ];

    const formatted = formatHighDensityDocContext(docWithLongCode, {
      totalTokenBudget: 100,
    });

    // 验证 fences 必须是偶数对（闭合状态）
    const fences = formatted.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || [];
    expect(fences.length % 2).toBe(0);
    expect(formatted).toContain('... [Section content truncated]');
  });

  it('多语言（日文、韩文、中文）标题锚点完整保留，绝不误杀', () => {
    const multiLangDocs: ChunkSearchResult[] = [
      {
        id: 'chunk-jp',
        path: 'docs/guide.md',
        heading: 'クイックスタート・ガイド',
        headingPath: null,
        title: 'JP Guide',
        similarity: 0.95,
        content: '日本語のドキュメントです。',
      },
      {
        id: 'chunk-kr',
        path: 'docs/intro.md',
        heading: '시작하기 가이드',
        headingPath: null,
        title: 'KR Intro',
        similarity: 0.9,
        content: '한국어 가이드입니다.',
      },
    ];

    const formatted = formatHighDensityDocContext(multiLangDocs, {
      owner: 'acme',
      repo: 'repo',
    });

    expect(formatted).toContain('URL: /docs/acme/repo/guide#クイックスタート・ガイド');
    expect(formatted).toContain('URL: /docs/acme/repo/intro#시작하기-가이드');
  });
});
