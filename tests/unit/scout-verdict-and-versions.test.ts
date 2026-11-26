import { test, expect, describe } from 'vitest';
import { normalizeLocale, detectLangFromPath } from '@/lib/languages';
import {
  buildDirInventory,
  buildDirTree,
  validateVerdict,
  mergeVerdictIntoVersions,
  DIR_TREE_MAX_NODES,
  type DirCandidate,
  type DirVerdict,
} from '@/lib/dir-verdict';
import { type GitHubNode } from '@/engine/repo-sniffer';
import {
  matchScoutVersion,
  fallbackPrefix,
  VERSION_MATCHERS,
  byExplicitPath,
  byPrimaryRole,
  ScoutVersionLike,
} from '@/lib/import-wizard/version-matchers';
import { buildHeuristicVersions, buildVersionCandidates } from '@/lib/scout/pipeline/version-candidates';
import { DEFAULT_METADATA } from '@/lib/scout/pipeline/metadata-ai';

describe('dir-verdict', () => {
  const inventoryNodes: GitHubNode[] = [
    { path: 'docs', type: 'tree' },
    { path: 'translations', type: 'tree' },
    { path: 'images', type: 'tree' },
    { path: 'translations/zh-CN', type: 'tree' },
    { path: 'translations/ja', type: 'tree' },
    { path: 'translations/zh-CN/00-intro', type: 'tree' },
    { path: 'translations/zh-CN/01-basics', type: 'tree' },
    { path: 'translations/ja/00-intro', type: 'tree' },
    { path: 'docs/guides', type: 'tree' },
    { path: 'docs/README.md', type: 'blob', size: 100 },
    { path: 'docs/guides/guide1.md', type: 'blob', size: 100 },
    { path: 'docs/guides/guide2.md', type: 'blob', size: 100 },
    { path: 'docs/guides/guide3.md', type: 'blob', size: 100 },
    { path: 'translations/zh-CN/00-intro/README.md', type: 'blob', size: 100 },
    { path: 'translations/zh-CN/00-intro/extra.md', type: 'blob', size: 100 },
    { path: 'translations/zh-CN/01-basics/README.md', type: 'blob', size: 100 },
    { path: 'translations/zh-CN/01-basics/extra.md', type: 'blob', size: 100 },
    { path: 'translations/zh-CN/01-basics/extra2.md', type: 'blob', size: 100 },
    { path: 'translations/ja/00-intro/README.md', type: 'blob', size: 100 },
    { path: 'translations/ja/00-intro/extra.md', type: 'blob', size: 100 },
    { path: 'translations/ja/00-intro/extra2.md', type: 'blob', size: 100 },
  ];

  test('normalizeLocale & detectLangFromPath 语言别名规范化与目录检测', () => {
    for (const [raw, expected] of [
      ['zh-cn', 'zh-CN'],
      ['zh_CN', 'zh-CN'],
      ['简体中文', 'zh-CN'],
      ['zh-tw', 'zh-TW'],
      ['日本語', 'ja'],
      ['english', 'en'],
      ['pt-br', 'pt-BR'],
      ['book', null],
      ['', null],
      [null, null],
    ] as const) {
      expect(normalizeLocale(raw), String(raw)).toBe(expected);
    }

    for (const [dirPath, expected] of [
      ['translations/zh-CN/', 'zh-CN'],
      ['book-zh/', 'zh-CN'],
      ['docs/es-MX/', 'es-MX'],
      ['i18n/ja/', 'ja'],
      ['book/', null],
      ['images/', null],
    ] as const) {
      expect(detectLangFromPath(dirPath), dirPath).toBe(expected);
    }
  });

  test('buildDirInventory / validateVerdict / mergeVerdictIntoVersions 清单、防幻觉校验与合并', () => {
    const inventory = buildDirInventory(inventoryNodes);
    const joined = inventory.lines.join('\n');
    expect(joined).toContain('translations/zh-CN/ (5 md)');
    expect(joined).toContain('docs/ (4 md)');
    expect(joined.split('\n').some((l) => l.startsWith('translations/zh-CN/00-intro'))).toBe(false);
    expect(buildDirInventory(inventoryNodes, 2)).toMatchObject({ truncated: true });

    const validated = validateVerdict(
      {
        primaryRoot: '',
        candidates: [
          { dir: 'translations/zh-CN/', lang: '简体中文', role: 'translation', confidence: 0.95 },
          { dir: 'translations/ja/', lang: 'ja', role: 'translation', confidence: 0.9 },
          { dir: 'fake/not-exists/', lang: 'zh', role: 'translation', confidence: 0.99 },
          { dir: 'images/', lang: 'zh', role: 'translation', confidence: 0.5 },
        ] as DirCandidate[],
      },
      inventoryNodes
    )!;
    expect(validated.candidates).toHaveLength(2);
    expect(validated.candidates[0].lang).toBe('zh-CN');
    expect(validateVerdict({ primaryRoot: 'fake/', candidates: [] }, inventoryNodes)).toBeNull();

    const heuristic = [
      { name: 'Root / Main Content', prefix: '' },
      { name: 'Translation (translations/zh-CN)', prefix: 'translations/zh-CN/' },
      { name: 'docs', prefix: 'docs/' },
    ];
    const merged = mergeVerdictIntoVersions(heuristic, validated);
    expect(merged.find((v) => v.prefix === 'translations/zh-CN/')?.name).toBe('简体中文 (translations/zh-CN/)');
    expect(merged.some((v) => v.prefix === 'translations/ja/')).toBe(true);
    expect(merged.some((v) => v.prefix === 'images/')).toBe(false);
    expect(mergeVerdictIntoVersions(heuristic, null)).toHaveLength(heuristic.length);
  });

  test('buildDirTree：多语言全量保留、数字感知自然序、超限整枝裁剪与代码统计', () => {
    const countTreeNodes = (nodes: { children: unknown[] }[]): number =>
      nodes.reduce((acc, n) => acc + 1 + countTreeNodes(n.children as { children: unknown[] }[]), 0);

    const multiNodes: GitHubNode[] = [{ path: 'translations', type: 'tree' }];
    for (let l = 0; l < 40; l++) {
      multiNodes.push({ path: `translations/lang${l}`, type: 'tree' });
      for (let c = 0; c < 19; c++) {
        const ch = `chapter${String(c).padStart(2, '0')}`;
        multiNodes.push({ path: `translations/lang${l}/${ch}`, type: 'tree' });
        multiNodes.push({ path: `translations/lang${l}/${ch}/README.md`, type: 'blob', size: 100 });
      }
    }
    const multiTree = buildDirTree(multiNodes);
    expect(countTreeNodes(multiTree)).toBe(801);
    expect(multiTree.find((n) => n.path === 'translations/')!.children).toHaveLength(40);

    const naturalTree = buildDirTree([
      { path: 'book/10-advanced', type: 'tree' },
      { path: 'book/2-basics', type: 'tree' },
      { path: 'book/0-intro', type: 'tree' },
    ]);
    expect(naturalTree.find((n) => n.path === 'book/')!.children.map((c) => c.name)).toEqual([
      '0-intro',
      '2-basics',
      '10-advanced',
    ]);

    const bigNodes: GitHubNode[] = [];
    for (let top = 0; top < 3; top++) {
      bigNodes.push({ path: `t${top}`, type: 'tree' });
      for (let i = 0; i < 700; i++) {
        bigNodes.push({ path: `t${top}/d${i}`, type: 'tree' });
        if (i < 3) bigNodes.push({ path: `t${top}/d${i}/README.md`, type: 'blob', size: 100 });
      }
    }
    const cappedTree = buildDirTree(bigNodes);
    expect(countTreeNodes(cappedTree)).toBeLessThanOrEqual(DIR_TREE_MAX_NODES);
    expect(countTreeNodes([cappedTree.find((n) => n.path === 't0/')!])).toBe(701);

    const codeTree = buildDirTree([
      { path: 'micrograd', type: 'tree' },
      { path: 'micrograd/engine.py', type: 'blob', size: 100 },
      { path: 'micrograd/nn.py', type: 'blob', size: 100 },
      { path: 'micrograd/__init__.py', type: 'blob', size: 100 },
    ]);
    expect(codeTree.find((n) => n.path === 'micrograd/')!).toMatchObject({
      mdCount: 0,
      codeCount: 3,
      primaryLang: 'python',
      keyFiles: ['engine.py', 'nn.py', '__init__.py'],
    });
  });
});

describe('version-matchers & scout-version-candidates', () => {
  const v = (over: Partial<ScoutVersionLike>): ScoutVersionLike => ({ prefix: '/docs/', totalFiles: 10, ...over });

  test('VERSION_MATCHERS 两环责任链：byExplicitPath 防空串劫持与 byPrimaryRole 根目录合法化', () => {
    expect(VERSION_MATCHERS).toHaveLength(2);

    const rootFirst = [v({ prefix: '' }), v({ prefix: 'docs/' })];
    expect(byExplicitPath(rootFirst, { filePath: 'docs' })?.prefix).toBe('docs/');
    expect(byExplicitPath(rootFirst, { filePath: 'changelogs' })).toBeNull();
    expect(byExplicitPath(rootFirst, { filePath: null })).toBeNull();

    expect(byPrimaryRole([v({ prefix: 'docs/', role: 'primary' })])?.prefix).toBe('docs/');
    expect(byPrimaryRole([v({ prefix: '', role: 'primary' }), v({ prefix: 'appendix-A/' })])?.prefix).toBe('');
    expect(byPrimaryRole([v({ prefix: 'appendix-A/' }), v({ prefix: 'ch01/' })])).toBeNull();
  });

  test('matchScoutVersion 端到端优先顺序、scope-verdict 链路与 fallbackPrefix', () => {
    expect(
      matchScoutVersion(
        [v({ prefix: '', role: 'primary', totalFiles: 100 }), v({ prefix: 'appendix-A/', totalFiles: 3 })],
        { filePath: null }
      )?.prefix
    ).toBe('');
    expect(
      matchScoutVersion([v({ prefix: '', role: 'primary' }), v({ prefix: 'packages/reactivity/' })], {
        filePath: 'packages/reactivity',
      })?.prefix
    ).toBe('packages/reactivity/');
    expect(matchScoutVersion([v({ prefix: 'a/' }), v({ prefix: 'b/' })], { filePath: null })).toBeNull();

    const verdict: DirVerdict = {
      primaryRoot: '',
      candidates: [
        { dir: '', lang: null, role: 'primary', confidence: 1 },
        { dir: 'setup/', lang: null, role: 'auxiliary', confidence: 1 },
      ],
    };
    const merged = mergeVerdictIntoVersions([{ name: 'Root', prefix: '' }, { name: 'Appendix', prefix: 'appendix-A/' }], verdict);
    expect(merged.some((x) => x.prefix === 'setup/')).toBe(false);
    expect(matchScoutVersion(merged, { filePath: null })?.prefix).toBe('');

    expect(fallbackPrefix('sub/dir')).toBe('sub/dir/');
    expect(fallbackPrefix(null)).toBe('');
  });

  test('scout version-candidates knownPrefixes 解耦、空输入兜底与 verdict 合并', () => {
    const md = (p: string): GitHubNode => ({ path: p, mode: '100644', type: 'blob', sha: 's', url: `https://example/${p}` });
    const heuristicInput = {
      repoProfileTextRoot: 'docs/',
      repoProfileTranslationRoots: ['zh-CN/'],
      markdownFiles: [md('docs/a.md'), md('docs/b/c.md'), md('docs/d.md'), md('guide/e.md'), md('guide/f.md'), md('guide/g.md'), md('advanced/h.md')],
      inspectionFilePath: 'tutorials/',
    };
    const primaryVerdict: DirVerdict = {
      primaryRoot: 'guide/',
      candidates: [
        { dir: 'guide/', lang: null, role: 'primary', confidence: 0.9 },
        { dir: 'advanced/', lang: null, role: 'auxiliary', confidence: 0.5 },
      ],
    };

    expect(DEFAULT_METADATA).toMatchObject({ aiCategory: 'Others', aiTags: '', paradigm: 'Engineering', parallelTracks: [] });

    const heuristic = buildHeuristicVersions(heuristicInput);
    const withVerdict = buildVersionCandidates({ ...heuristicInput, verdict: primaryVerdict });
    const withoutVerdict = buildVersionCandidates({ ...heuristicInput, verdict: null });
    expect([...heuristic.knownPrefixes].sort()).toEqual([...withVerdict.knownPrefixes].sort());
    expect([...heuristic.knownPrefixes].sort()).toEqual([...withoutVerdict.knownPrefixes].sort());
    expect(heuristic.knownPrefixes.has('docs/')).toBe(true);
    expect(heuristic.knownPrefixes.has('guide/')).toBe(true);
    expect(heuristic.knownPrefixes.has('advanced/')).toBe(false);

    expect(withVerdict.versions.some((x) => x.prefix === 'guide/')).toBe(true);
    expect(withVerdict.versions.some((x) => x.prefix === 'advanced/')).toBe(false);

    const emptyResult = buildVersionCandidates({ repoProfileTextRoot: '', repoProfileTranslationRoots: [], markdownFiles: [], verdict: null });
    expect(emptyResult.versions).toHaveLength(1);
    expect(emptyResult.knownPrefixes.has('')).toBe(true);
  });
});
