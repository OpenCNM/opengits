import { describe, it, expect } from 'vitest';
import { foldScopeRows, parseHubRef, buildEditionHint, editionAttribution } from '@/lib/mcp/edition-scope';
import { fallbackWarning, RepoContext, RepoRuntime } from '@/lib/mcp/tools/shared';
import { runOutline } from '@/lib/mcp/tools/outline';
import { runSearchSymbols } from '@/lib/mcp/tools/symbol';
import { capFullDocText, formatNavTree, findDocInContext } from '@/lib/mcp/repo-tools';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';
import { type NavNode } from '@/engine/structurizer';
import { isWebDocRepository, resolveRepositoryDisplayName, resolveDocLiveUrl } from '@/lib/repository-resolver';

describe('mcp-edition-and-symbols', () => {
  const row = (id: string, owner: string, repo: string, edition: string, branch = 'main') =>
    ({ id, owner, repo, branch, edition } as const);

  it('foldScopeRows 扇出折叠：单讲法/最近在读/基础行优先/同时间戳破平/分枝隔离', () => {
    expect(foldScopeRows([row('1', 'o', 'r', '')])).toHaveLength(1);
    const activity = new Map([['analogy-row', Date.now()]]);
    expect(foldScopeRows([row('base-row', 'o', 'r', ''), row('analogy-row', 'o', 'r', 'ed_aa')], activity)[0].preferred.id).toBe(
      'analogy-row'
    );
    expect(foldScopeRows([row('b', 'o', 'r', 'ed_bb'), row('base', 'o', 'r', ''), row('a', 'o', 'r', 'ed_aa')])[0].preferred.id).toBe(
      'base'
    );
    const ts = Date.now();
    expect(
      foldScopeRows([row('b', 'o', 'r', 'ed_bb'), row('a', 'o', 'r', 'ed_aa')], new Map([['a', ts], ['b', ts]]))[0].preferred.id
    ).toBe('a');

    const branches = foldScopeRows([row('1', 'O', 'R', '', 'main'), row('2', 'o', 'r', 'ed_aa', 'main'), row('3', 'o', 'r', '', 'v15')]);
    expect(branches).toHaveLength(2);
    expect(branches.find((g) => g.key.includes('main'))!.rows).toHaveLength(2);
    expect(branches.find((g) => g.key.includes('v15'))!.rows).toHaveLength(1);
  });

  it('parseHubRef / editionAttribution / buildEditionHint 引用解析与归因指引', () => {
    expect(parseHubRef('tokio-rs/tokio')).toEqual({ base: 'tokio-rs/tokio', edition: null });
    expect(parseHubRef('tokio-rs/tokio@ed_ab12cd34')).toEqual({ base: 'tokio-rs/tokio', edition: 'ed_ab12cd34' });
    expect(parseHubRef('cli123abc@ed_ff')).toEqual({ base: 'cli123abc', edition: 'ed_ff' });
    expect(parseHubRef('owner/repo@')).toEqual({ base: 'owner/repo@', edition: null });

    expect(editionAttribution({ editionLabel: 'JS 类比版' }, '')).toBe('');
    expect(editionAttribution({ editionLabel: 'JS 类比版' }, 'ed_aa')).toBe(' · 讲法: JS 类比版');
    expect(editionAttribution(null, null)).toBe('');

    expect(buildEditionHint(foldScopeRows([row('1', 'o', 'r', '')]))).toBe('');
    const hint = buildEditionHint(foldScopeRows([row('base', 'o', 'r', ''), row('a', 'o', 'r', 'ed_aa')]));
    expect(hint).toContain('1 个仓库');
    expect(hint).toContain('o/r@ed_aa');
  });

  it('fallbackWarning 讲法回退 fail-loud 警告与 outline 端到端头部注入', async () => {
    const baseCtx = (over: Partial<RepoContext> = {}): RepoContext => ({
      owner: 'acme',
      repo: 'calculator',
      repository: { id: 'repo-1', owner: 'acme', repo: 'calculator', branch: 'main', repoProfile: {}, navTree: [], documents: [] },
      ...over,
    });

    const baseWarn = fallbackWarning(baseCtx({ isFallback: true, requestedEdition: 'ed_deep', edition: '' }));
    expect(baseWarn).toContain('⚠ Edition fallback: requested "ed_deep" was not found');
    expect(baseWarn).toContain('BASE edition');

    const edWarn = fallbackWarning(baseCtx({ isFallback: true, requestedEdition: 'v16', edition: 'ed_deep', editionLabel: '深度剖析版' }));
    expect(edWarn).toContain('edition "深度剖析版"');

    expect(fallbackWarning(baseCtx())).toBe('');
    expect(fallbackWarning(baseCtx({ isFallback: false, requestedEdition: 'ed_deep' }))).toBe('');

    const res = await runOutline({}, { multiRepo: false, resolveRepository: async () => baseCtx({ isFallback: true, requestedEdition: 'ed_deep' }) } as any);
    expect((res.content[0] as { text: string }).text).toContain('⚠ Edition fallback: requested "ed_deep" was not found');
  });

  it('runSearchSymbols 关键字过滤 / 空 query / file 过滤 / limit / 未命中 / Hub 缺失 repository', async () => {
    const mockRepo = {
      id: 'repo-calc-1',
      owner: 'acme',
      repo: 'calculator',
      branch: 'main',
      gitSha: 'sha-abc-123',
      repoProfile: {
        codeClusters: [
          {
            title: 'Math Core',
            directories: ['src/math'],
            files: ['src/math/calc.ts', 'src/math/types.ts'],
            teachingOrder: 1,
            chapterNo: 1,
            summary: 'Core arithmetic operators',
            cognitive: {
              phase: 'core',
              goldenSymbols: [
                { name: 'add', kind: 'function', file: 'src/math/calc.ts' },
                { name: 'Calculator', kind: 'class', file: 'src/math/calc.ts' },
                { name: 'CalcConfig', kind: 'type', file: 'src/math/types.ts' },
              ],
              callFlow: [{ caller: 'Calculator.compute', callee: 'add', calleeFile: 'src/math/calc.ts' }],
            },
          },
        ],
      },
      navTree: [{ type: 'page', title: 'Chapter 1: Arithmetic Core', path: 'ch01-math.md' }],
      documents: [{ id: 'doc-1', title: 'Chapter 1: Arithmetic Core', path: 'ch01-math.md' }],
    };
    const mkRuntime = (multiRepo = false): RepoRuntime => ({
      multiRepo,
      resolveRepository: async () => ({ repository: mockRepo, documents: mockRepo.documents, navTree: mockRepo.navTree }),
    });

    const hit = await runSearchSymbols({ query: 'calc' }, mkRuntime());
    expect(hit.content[0].text).toContain('Calculator` (class)');
    expect(hit.content[0].text).toContain('CalcConfig` (type)');

    const all = await runSearchSymbols({}, mkRuntime());
    expect(all.content[0].text).toContain('Top Architectural Symbols in acme/calculator');

    const byFile = await runSearchSymbols({ query: 'calc', file: 'types.ts' }, mkRuntime());
    expect(byFile.content[0].text).toContain('CalcConfig` (type)');
    expect(byFile.content[0].text).not.toContain('Calculator` (class)');

    expect((await runSearchSymbols({ limit: 1 }, mkRuntime())).content[0].text).toContain('Found 1');
    expect((await runSearchSymbols({ query: 'NonExistentXYZ' }, mkRuntime())).content[0].text).toContain('No symbols found');

    const hubErr = await runSearchSymbols({ query: 'add' }, mkRuntime(true));
    expect(hubErr.isError).toBe(true);
    expect(hubErr.content[0].text).toContain('"repository" is required');
  });

  it('repo-tools-format: capFullDocText / formatNavTree / findDocInContext / resolveDocLiveUrl', () => {
    const exact = 'x'.repeat(MCP_DOC_FULL_MAX_CHARS);
    expect(capFullDocText(exact)).toBe(exact);
    expect(capFullDocText('x'.repeat(MCP_DOC_FULL_MAX_CHARS + 1000))).toContain('Truncated for context limit');

    const tree: NavNode[] = [
      {
        name: 'book',
        title: 'Book',
        type: 'directory',
        path: 'book',
        url: '/docs/o/r/book',
        children: [{ name: 'intro.md', title: 'Intro', type: 'file', path: 'book/intro.md', url: '/docs/o/r/book/intro' }],
      },
      { name: 'readme.md', title: 'Readme', type: 'file', path: 'readme.md', url: '/docs/o/r' },
    ];
    const formatted = formatNavTree(tree);
    const text = typeof formatted === 'string' ? formatted : formatted.text;
    expect(text).toContain('📁 Book');
    expect(text).toContain(' 📄 Intro (book/intro.md)');
    expect(text).toContain('📄 Readme (readme.md)');

    const ctx = { repository: { documents: [{ path: 'docs/Intro.md' }, { path: 'guide.mdx' }] } } as any;
    expect(findDocInContext(ctx, 'docs/Intro')).toBeTruthy();
    expect(findDocInContext(ctx, 'guide')).toBeTruthy();
    expect(findDocInContext(ctx, 'DOCS/INTRO')).toBeTruthy();
    expect(findDocInContext(ctx, 'missing')).toBeUndefined();

    expect(isWebDocRepository({ owner: 'web-docs', repo: 'x' })).toBe(true);
    expect(isWebDocRepository({ owner: 'bojieli', repo: 'ai-agent-book', category: 'AI' })).toBe(false);
    expect(resolveRepositoryDisplayName({ owner: 'web-docs', repo: 'x', repoProfile: { siteTitle: 'GPUI', sourceType: 'web' } })).toBe('GPUI');
    expect(resolveRepositoryDisplayName({ owner: 'bojieli', repo: 'ai-agent-book' })).toBe('bojieli/ai-agent-book');

    const webNav = [
      {
        name: 'Guide',
        path: 'docs/guide',
        type: 'directory',
        children: [{ name: 'Installation', path: 'docs/guide/installation.md', type: 'file', sourceUrl: 'https://longbridge.github.io/gpui-component/docs/installation' }],
      },
    ];
    expect(resolveDocLiveUrl(webNav, 'docs/guide/installation.md', 'https://longbridge.github.io/gpui-component')).toBe(
      'https://longbridge.github.io/gpui-component/docs/installation'
    );
    expect(resolveDocLiveUrl(webNav, 'docs/guide/unknown.md', 'https://longbridge.github.io/gpui-component')).toBe(
      'https://longbridge.github.io/gpui-component'
    );
    expect(resolveDocLiveUrl(null, 'any.md')).toBeNull();
  });
});
