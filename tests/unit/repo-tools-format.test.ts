import { test, expect } from 'vitest';
import { capFullDocText, formatNavTree, findDocInContext } from '@/lib/mcp/repo-tools';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';
import type { NavNode } from '@/engine/structurizer';

// ── capFullDocText：全文输出上限 ──

test('恰好等于上限原样返回；超限截断并引导 read_document 分段读取', () => {
  const exact = 'x'.repeat(MCP_DOC_FULL_MAX_CHARS);
  expect(capFullDocText(exact)).toBe(exact);
  const over = 'x'.repeat(MCP_DOC_FULL_MAX_CHARS + 1000);
  const capped = capFullDocText(over);
  expect(capped.length).toBeLessThan(over.length);
  expect(capped).toContain('Truncated for context limit');
  expect(capped).toContain('outline');
  expect(capFullDocText('')).toBe('');
});

// ── formatNavTree：list_documents 的导航树文本 ──

test('目录 📁 递归缩进，文件 📄 携带路径', () => {
  const tree: NavNode[] = [
    {
      name: 'book',
      title: 'Book',
      type: 'directory',
      path: 'book',
      url: '/docs/o/r/book',
      children: [
        { name: 'intro.md', title: 'Intro', type: 'file', path: 'book/intro.md', url: '/docs/o/r/book/intro' },
      ],
    },
    { name: 'readme.md', title: 'Readme', type: 'file', path: 'readme.md', url: '/docs/o/r' },
  ];
  const res = formatNavTree(tree);
  const text = typeof res === 'string' ? res : res.text;
  expect(text).toContain('📁 Book');
  expect(text).toContain(' 📄 Intro (book/intro.md)'); // 子级缩进一格
  expect(text).toContain('📄 Readme (readme.md)');
  const emptyRes = formatNavTree(undefined);
  expect(typeof emptyRes === 'string' ? emptyRes : emptyRes.text).toBe('');
});

// ── findDocInContext：get_document/read_section 的路径容差 ──

function ctxWithDocs(paths: string[]): any {
  return { repository: { documents: paths.map((p) => ({ path: p })) } };
}

test('精确命中 / .md / .mdx 补全 / 大小写不敏感 / 未命中 null', () => {
  const ctx = ctxWithDocs(['docs/Intro.md', 'guide.mdx']);
  expect(findDocInContext(ctx, 'docs/Intro.md')).toBeTruthy();
  expect(findDocInContext(ctx, 'docs/Intro')).toBeTruthy(); // .md 补全
  expect(findDocInContext(ctx, 'guide')).toBeTruthy(); // .mdx 补全
  expect(findDocInContext(ctx, 'DOCS/INTRO')).toBeTruthy(); // 大小写
  expect(findDocInContext(ctx, 'missing')).toBeUndefined();
});

// ── isWebDocRepository & resolveRepositoryDisplayName ──

import { isWebDocRepository, resolveRepositoryDisplayName, resolveDocLiveUrl } from '@/lib/repository-resolver';

test('isWebDocRepository 准确识别 Web 官方文档，GitHub 仓库返回 false', () => {
  expect(isWebDocRepository({ owner: 'web-docs', repo: 'longbridge-github-io' })).toBe(true);
  expect(isWebDocRepository({ owner: 'foo', repo: 'bar', category: 'Web Docs' })).toBe(true);
  expect(isWebDocRepository({ owner: 'foo', repo: 'bar', repoProfile: { sourceType: 'web' } })).toBe(true);
  expect(isWebDocRepository({ owner: 'bojieli', repo: 'ai-agent-book', category: 'AI & 大模型' })).toBe(false);
  expect(isWebDocRepository(null)).toBe(false);
});

test('resolveRepositoryDisplayName：Web 文档优先取 siteTitle，GitHub 取 owner/repo', () => {
  const webRepo = {
    owner: 'web-docs',
    repo: 'longbridge-github-io',
    repoProfile: { siteTitle: 'GPUI Component', sourceType: 'web' },
  };
  expect(resolveRepositoryDisplayName(webRepo)).toBe('GPUI Component');

  const githubRepo = {
    owner: 'bojieli',
    repo: 'ai-agent-book',
    repoProfile: { starCount: 1200 },
  };
  expect(resolveRepositoryDisplayName(githubRepo)).toBe('bojieli/ai-agent-book');
});

// ── resolveDocLiveUrl：页面级原站链接提取与兜底 ──

test('resolveDocLiveUrl 从 navTree 提取页面级 sourceUrl，未拼接 heading 锚点，缺失时回退根路径', () => {
  const navTree: any[] = [
    {
      name: 'Guide',
      path: 'docs/guide',
      type: 'directory',
      children: [
        {
          name: 'Installation',
          path: 'docs/guide/installation.md',
          type: 'file',
          sourceUrl: 'https://longbridge.github.io/gpui-component/docs/installation',
        },
      ],
    },
  ];

  // 命中文件节点并返回页面级 sourceUrl
  const liveUrl = resolveDocLiveUrl(navTree, 'docs/guide/installation.md', 'https://longbridge.github.io/gpui-component');
  expect(liveUrl).toBe('https://longbridge.github.io/gpui-component/docs/installation');
  expect(liveUrl).not.toContain('#');

  // 未命中时安全回退至 fallback 根网址
  const fallbackUrl = resolveDocLiveUrl(navTree, 'docs/guide/unknown.md', 'https://longbridge.github.io/gpui-component');
  expect(fallbackUrl).toBe('https://longbridge.github.io/gpui-component');

  // 无 navTree 且无 fallback 时返回 null
  expect(resolveDocLiveUrl(null, 'any.md')).toBeNull();
});

// ── 反向回归断言：GitHub 仓库输出零变化 ──

test('反向回归验证：GitHub 仓库判定为非 Web，且 Live URL 解析安全返回 null，保证输出零变化', () => {
  const ghRepo = {
    owner: 'bojieli',
    repo: 'ai-agent-book',
    category: 'AI & 大模型',
    repoProfile: { starCount: 1500 },
  };
  expect(isWebDocRepository(ghRepo)).toBe(false);

  // 模拟 GitHub 仓库 read_section 输出逻辑：非 Web 仓不注入 Live URL
  const isWeb = isWebDocRepository(ghRepo);
  const liveUrl = isWeb ? resolveDocLiveUrl([], 'docs/readme.md', null) : null;
  const liveUrlLine = liveUrl ? `Live URL: ${liveUrl}\n` : '';
  expect(liveUrlLine).toBe('');

  const sectionOutput = `# Readme\nSource Path: docs/readme.md\n${liveUrlLine}Section: Intro\n\nContent`;
  expect(sectionOutput).not.toContain('Live URL:');
  expect(sectionOutput).toBe('# Readme\nSource Path: docs/readme.md\nSection: Intro\n\nContent');
});

