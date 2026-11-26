import { describe, it, expect } from 'vitest';
import {
  generateEditionKey,
  resolveEditionForKey,
  buildRepoEditionGroups,
  sameSourceEditionGroupKey,
  resolveEditionChipDisplayLabel,
} from '@/lib/edition';
import { deriveEditionLabel, editionParamFromUrl } from '@/lib/repository-resolver';
import { resolveEditionHref } from '@/components/docs/DocsEdition';
import { resolveEffectiveChapterVersion } from '@/lib/docs/docs-page-loader';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAPTER_STALL_THRESHOLD_MS, evaluateChapterTranscriptionHealth } from '@/lib/ingest/chapter-health';
import { chapterMapSchema } from '@/engine/chapter-map';
import { applyDeepDiveOpenState, readDeepDivePreference } from '@/components/mdx/DocNavActions/DeepDiveToggle';
import { shouldShowChapterDegradedNotice } from '@/components/docs/ChapterDegradedNotice';
import { isScopedLocalArchive, SCOPED_UNPACK_MARKER } from '@/engine/repo-tarball';
import {
  DEFAULT_THEME,
  DEEP_DIVE_LAYER_ATTRIBUTE,
  DEEP_DIVE_LAYER_VALUE,
  GENERATION_LEVEL,
  STORAGE_KEYS,
} from '@/lib/constants';
import { applyThemeToDom, resolveTheme, THEME_INIT_SCRIPT, themeToColorScheme } from '@/lib/theme';

describe('edition-and-chapter-prefs', () => {
  it('generateEditionKey & resolveEditionForKey 讲法键生成与优先级', () => {
    const key1 = generateEditionKey();
    const key2 = generateEditionKey();
    expect(key1).toMatch(/^ed_[0-9a-f]{8}$/);
    expect(key1).not.toBe(key2);

    expect(resolveEditionForKey({ edition: 'ed_abcd1234' })).toBe('ed_abcd1234');
    expect(resolveEditionForKey({ edition: '  ed_abcd1234  ' })).toBe('ed_abcd1234');
    expect(resolveEditionForKey({ edition: '   ' })).toBe('');
    expect(resolveEditionForKey({ createEdition: true })).toMatch(/^ed_[0-9a-f]{8}$/);
    expect(resolveEditionForKey({ edition: 'ed_00000000', createEdition: true })).toBe('ed_00000000');
    expect(resolveEditionForKey({})).toBe('');
    expect(resolveEditionForKey({ createEdition: false })).toBe('');
  });

  it('deriveEditionLabel & resolveEditionChipDisplayLabel 讲法展示标签推导与去占位符', () => {
    expect(deriveEditionLabel({ editionLabel: 'JS 类比版', transcriptionPreset: 'analogy' })).toBe('JS 类比版');
    expect(deriveEditionLabel({ editionLabel: '教学解读版', transcriptionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel({ editionLabel: '教学解读', transcriptionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel({ transcriptionPreset: 'standard' }, ['qwen3.8-max'])).toBe('qwen3.8-max');
    expect(deriveEditionLabel({ editionLabel: '讲法 ed_d09bdeae' }, ['qwen3.8-max'])).toBe('qwen3.8-max');
    expect(deriveEditionLabel(null, ['qwen3.8-flash'])).toBe('qwen3.8-flash');
    expect(deriveEditionLabel({ transcriptionModel: 'glm-5.3-flash', editionPreset: 'standard' })).toBe('glm-5.3-flash');
    expect(deriveEditionLabel({ model: 'qwen-max', transcriptionPreset: 'standard' })).toBe('qwen-max');
    expect(deriveEditionLabel({ activeModel: 'qwen3.8-flash', editionPreset: 'deep' })).toBe('qwen3.8-flash');
    expect(deriveEditionLabel({ transcriptionPreset: 'analogy' })).toBe('类比桥接版');
    expect(deriveEditionLabel({ editionPreset: 'cheatsheet' })).toBe('速查手册版');
    expect(deriveEditionLabel({ transcriptionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel({ editionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel(null)).toBe('标准教程');
    expect(deriveEditionLabel({})).toBe('标准教程');

    expect(
      resolveEditionChipDisplayLabel({ label: '讲法 ed_d09bdeae', transcriptionModels: ['qwen3.8-max'], isDefault: true })
    ).toBe('qwen3.8-max');
    expect(
      resolveEditionChipDisplayLabel({ label: '教学解读版', transcriptionModels: ['glm-5.3-flash'], isDefault: false })
    ).toBe('glm-5.3-flash');
    expect(
      resolveEditionChipDisplayLabel({ label: '标准教程', transcriptionModels: ['qwen3.8-flash'], isDefault: false })
    ).toBe('qwen3.8-flash');
    expect(
      resolveEditionChipDisplayLabel({ label: '教学解读版', transcriptionModels: [], isDefault: false })
    ).toBe('标准教程');
    expect(
      resolveEditionChipDisplayLabel({ label: '小白速成指南', transcriptionModels: ['qwen3.8-max'], isDefault: false })
    ).toBe('小白速成指南');
  });

  it('editionParamFromUrl 读取 ?edition= 且异常输入安全降级', () => {
    expect(editionParamFromUrl(new Request('https://x.dev/api?edition=ed_ab12'))).toBe('ed_ab12');
    expect(editionParamFromUrl(new Request('https://x.dev/api'))).toBe('');
    expect(editionParamFromUrl({} as Request)).toBe('');
  });

  it('buildRepoEditionGroups 单行/多讲法/无基础行/大小写分组与同源簇聚', () => {
    const row = (id: string, owner: string, repo: string, edition: string, updatedAt: string) =>
      ({ id, owner, repo, edition, updatedAt } as const);

    const single = buildRepoEditionGroups([row('1', 'tokio-rs', 'tokio', '', '2026-01-01')]);
    expect(single).toHaveLength(1);
    expect(single[0].primary.id).toBe('1');
    expect(single[0].siblings).toHaveLength(0);

    const multi = buildRepoEditionGroups([
      row('a', 'tokio-rs', 'tokio', 'ed_bb', '2026-01-03'),
      row('b', 'tokio-rs', 'tokio', '', '2026-01-01'),
      row('c', 'tokio-rs', 'tokio', 'ed_aa', '2026-01-02'),
    ]);
    expect(multi[0].primary.id).toBe('b');
    expect(multi[0].siblings.map((s) => s.id)).toEqual(['c', 'a']);
    expect(multi[0].editionCount).toBe(3);

    const noBase = buildRepoEditionGroups([
      row('a', 'o', 'r', 'ed_aa', '2026-01-01'),
      row('b', 'o', 'r', 'ed_bb', '2026-03-01'),
      row('c', 'o', 'r', 'ed_cc', '2026-02-01'),
    ]);
    expect(noBase[0].primary.id).toBe('b');
    expect(noBase[0].siblings.map((s) => s.id)).toEqual(['a', 'c']);

    const caseInsensitive = buildRepoEditionGroups([
      row('1', 'Tokio-RS', 'tokio', '', '2026-01-01'),
      row('2', 'tokio-rs', 'tokio', 'ed_aa', '2026-01-02'),
      row('3', 'vercel', 'next.js', '', '2026-01-01'),
    ]);
    expect(caseInsensitive).toHaveLength(2);
    expect(caseInsensitive.find((g) => g.primary.repo === 'tokio')!.editionCount).toBe(2);

    const cluster = buildRepoEditionGroups(
      [
        { ...row('1', 'original', 'repo', '', '2026-01-01'), sourceClusterKey: 'cluster-a' },
        { ...row('2', 'cloner', 'repo-copy', '', '2026-01-02'), sourceClusterKey: 'cluster-a' },
        { ...row('3', 'other', 'unrelated', '', '2026-01-01'), sourceClusterKey: null },
      ],
      { groupKey: sameSourceEditionGroupKey }
    );
    expect(cluster).toHaveLength(2);
    expect(cluster.find((g) => g.primary.sourceClusterKey === 'cluster-a')!.siblings.map((s) => s.id)).toEqual(['2']);

    const branchDrift = buildRepoEditionGroups(
      [
        { ...row('1', 'projectdiscovery', 'nuclei', 'ed_max', '2026-10-04'), sourceClusterKey: 'hash-dev' },
        { ...row('2', 'projectdiscovery', 'nuclei', '', '2026-09-23'), sourceClusterKey: null },
      ],
      { groupKey: sameSourceEditionGroupKey }
    );
    expect(branchDrift).toHaveLength(1);
    expect(branchDrift[0].primary.id).toBe('2');
  });

  it('resolveEditionHref 跨讲法切换直链解析（同 slug / 缺失回首章 / readme / 中文 URI）', () => {
    const OWNER = 'karpathy';
    const REPO = 'micrograd';
    const BASE = `/docs/${OWNER}/${REPO}`;
    const treeOf = (urls: string[]) => ({
      children: urls.map((url, i) =>
        i === 0 ? { name: 'root-folder', root: { name: '首章', url }, children: [] } : { name: `p${i}`, url }
      ),
    });
    const deepTree = treeOf([`${BASE}/01-intro`, `${BASE}/02-engine`, `${BASE}/03-advanced`]);

    expect(
      resolveEditionHref({ targetEdition: 'ed_deep', isDefault: false, pathname: `${BASE}/02-engine`, owner: OWNER, repo: REPO, tree: deepTree })
    ).toBe(`${BASE}/02-engine?edition=ed_deep`);
    expect(
      resolveEditionHref({ targetEdition: 'ed_deep', isDefault: false, pathname: `${BASE}/legacy-only-in-base`, owner: OWNER, repo: REPO, tree: deepTree })
    ).toBe(`${BASE}/01-intro?edition=ed_deep`);
    expect(
      resolveEditionHref({ targetEdition: '', isDefault: true, pathname: `${BASE}/edition-only-chapter`, owner: OWNER, repo: REPO, tree: deepTree })
    ).toBe(`${BASE}/01-intro`);
    expect(
      resolveEditionHref({ targetEdition: 'ed_new', isDefault: false, pathname: `${BASE}/02-engine`, owner: OWNER, repo: REPO, tree: undefined })
    ).toBe(`${BASE}/02-engine?edition=ed_new`);
    expect(
      resolveEditionHref({ targetEdition: 'ed_deep', isDefault: false, pathname: `${BASE}/readme`, owner: OWNER, repo: REPO, tree: treeOf([`${BASE}`, `${BASE}/01-intro`]) })
    ).toBe(`${BASE}/readme?edition=ed_deep`);
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: `${BASE}/01-引言`,
        owner: OWNER,
        repo: REPO,
        tree: treeOf([`${BASE}/01-%E5%BC%95%E8%A8%80`, `${BASE}/02-%E5%BC%95%E6%93%8E`]),
      })
    ).toBe(`${BASE}/01-引言?edition=ed_deep`);

    const zhOwner = '张三';
    const zhRepo = '项目';
    const zhBase = `/docs/${zhOwner}/${zhRepo}`;
    const encodedPathname = `/docs/${encodeURIComponent(zhOwner)}/${encodeURIComponent(zhRepo)}/02-engine`;
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: encodedPathname,
        owner: zhOwner,
        repo: zhRepo,
        tree: treeOf([`${zhBase}/01-intro`, `${zhBase}/02-engine`]),
      })
    ).toBe(`${encodedPathname}?edition=ed_deep`);
  });

  it('resolveEffectiveChapterVersion 悬空版本回退与 ChapterVersionVote 唯一索引守卫', () => {
    const validContentPool = new Set(['content-valid-1', 'content-valid-2']);
    const resolution = resolveEffectiveChapterVersion(
      [
        { id: 'v-corrupted-canonical', contentId: 'content-deleted-ghost', isCanonical: true, visibility: 'PUBLIC' },
        { id: 'v-community-1', contentId: 'content-valid-1', isCanonical: false, visibility: 'PUBLIC' },
      ],
      { validContentIds: validContentPool }
    );
    expect(resolution.hasFallback).toBe(true);
    expect(resolution.activeVersion?.id).toBe('v-community-1');

    const allCorrupted = resolveEffectiveChapterVersion(
      [{ id: 'v-1', contentId: 'ghost-1', isCanonical: true, visibility: 'PUBLIC' }],
      { validContentIds: validContentPool }
    );
    expect(allCorrupted.activeVersion).toBeNull();
    expect(allCorrupted.sanitizedVersions.every((v) => v.isCorrupted)).toBe(true);

    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
    const voteModelBlock = schema.match(/model ChapterVersionVote\s*\{[\s\S]*?\n\}/)?.[0] || '';
    expect(voteModelBlock).toMatch(/@@unique\(\[versionId,\s*userId\]\)/);
  });

  it('evaluateChapterTranscriptionHealth 队列健康/卡死判定矩阵', () => {
    const now = 1_700_000_000_000;
    const cases: Array<[string, Parameters<typeof evaluateChapterTranscriptionHealth>[0], { isHealthyQueued: boolean; isStalled: boolean }]> = [
      ['UNPROCESSED + active sibling', { docStatus: 'UNPROCESSED', jobStatus: null, hasActiveRepoSibling: true, serverUpdatedAtMs: null, fallbackActivityMs: now - 600_000, nowMs: now }, { isHealthyQueued: true, isStalled: false }],
      ['UNPROCESSED + QUEUED job', { docStatus: 'UNPROCESSED', jobStatus: 'QUEUED', hasActiveRepoSibling: false, serverUpdatedAtMs: null, fallbackActivityMs: now - 300_000, nowMs: now }, { isHealthyQueued: true, isStalled: false }],
      ['UNPROCESSED stalled', { docStatus: 'UNPROCESSED', jobStatus: null, hasActiveRepoSibling: false, serverUpdatedAtMs: null, fallbackActivityMs: now - (CHAPTER_STALL_THRESHOLD_MS + 1000), nowMs: now }, { isHealthyQueued: false, isStalled: true }],
      ['PROCESSING stalled via heartbeat', { docStatus: 'PROCESSING', jobStatus: 'RUNNING', hasActiveRepoSibling: false, serverUpdatedAtMs: now - (CHAPTER_STALL_THRESHOLD_MS + 5000), fallbackActivityMs: now, nowMs: now }, { isHealthyQueued: false, isStalled: true }],
      ['PROCESSING healthy heartbeat', { docStatus: 'PROCESSING', jobStatus: 'RUNNING', hasActiveRepoSibling: false, serverUpdatedAtMs: now - 15_000, fallbackActivityMs: now - 200_000, nowMs: now }, { isHealthyQueued: false, isStalled: false }],
      ['PROCESSED terminal', { docStatus: 'PROCESSED', jobStatus: null, hasActiveRepoSibling: false, serverUpdatedAtMs: now - 500_000, fallbackActivityMs: now - 500_000, nowMs: now }, { isHealthyQueued: false, isStalled: false }],
      ['ERROR terminal', { docStatus: 'ERROR', jobStatus: 'FAILED', hasActiveRepoSibling: false, serverUpdatedAtMs: now - 500_000, fallbackActivityMs: now - 500_000, nowMs: now }, { isHealthyQueued: false, isStalled: false }],
    ];
    for (const [label, input, expected] of cases) {
      expect(evaluateChapterTranscriptionHealth(input), label).toEqual(expected);
    }
  });

  it('chapterMapSchema 漂移字段回退默认值', () => {
    const full = chapterMapSchema.parse({
      isTutorial: true,
      chapters: [{ order: 1, title: 'Intro', mainPath: '01-intro.md', assetPaths: [{ path: 'lab.py', kind: 'exercise' }] }],
    });
    expect(full.chapters[0].assetPaths[0].kind).toBe('exercise');

    const drifted = chapterMapSchema.parse({
      isTutorial: 'yes',
      chapters: [{ order: 'x', title: 42, mainPath: null, assetPaths: 'n/a' }],
    });
    expect(drifted.isTutorial).toBe(false);
    expect(drifted.chapters[0]).toEqual({ order: 0, title: '', mainPath: '', assetPaths: [] });
    expect(chapterMapSchema.parse({}).chapters).toEqual([]);
  });

  it('DeepDiveToggle applyDeepDiveOpenState 与 readDeepDivePreference 偏好同步及安全兜底', () => {
    const blocks = [{ open: false }, { open: true }] as unknown as HTMLDetailsElement[];
    const seenSelectors: string[] = [];
    const fakeRoot = {
      querySelectorAll(selector: string) {
        seenSelectors.push(selector);
        return blocks;
      },
    } as unknown as ParentNode;

    applyDeepDiveOpenState(true, fakeRoot);
    expect(seenSelectors[0]).toBe(`details[${DEEP_DIVE_LAYER_ATTRIBUTE}="${DEEP_DIVE_LAYER_VALUE}"]`);
    expect(blocks.every((b) => b.open === true)).toBe(true);

    applyDeepDiveOpenState(false, fakeRoot);
    expect(blocks.every((b) => b.open === false)).toBe(true);

    // No window in node env → fail-safe default false; mock localStorage when present
    expect(readDeepDivePreference()).toBe(false);
    const prevWindow = (globalThis as Record<string, unknown>).window;
    try {
      (globalThis as Record<string, unknown>).window = {
        localStorage: {
          getItem: (k: string) => (k === STORAGE_KEYS.READER_DEEP_DIVE_OPEN ? '1' : null),
        },
      };
      expect(readDeepDivePreference()).toBe(true);
    } finally {
      if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });

  it('shouldShowChapterDegradedNotice 仅对可翻译 Markdown 原文显示，且 isScopedLocalArchive 识别局部解压标记', async () => {
    const noticeCases: Array<[string, Parameters<typeof shouldShowChapterDegradedNotice>[0], boolean]> = [
      ['degraded markdown original + zh-CN shows notice', { generationLevel: GENERATION_LEVEL.ORIGINAL, targetLanguage: 'zh-CN', docPath: 'docs/guide.md' }, true],
      ['degraded mdx original with anchor shows notice', { generationLevel: GENERATION_LEVEL.ORIGINAL, targetLanguage: 'zh-CN', docPath: 'docs/intro.mdx#sec' }, true],
      ['non-markdown .ts asset hides notice even with zh-CN', { generationLevel: GENERATION_LEVEL.ORIGINAL, targetLanguage: 'zh-CN', docPath: 'packages/shared/src/index.ts' }, false],
      ['non-markdown .py asset hides notice', { generationLevel: GENERATION_LEVEL.ORIGINAL, targetLanguage: 'zh-CN', docPath: 'src/main.py' }, false],
      ['targetLanguage none or original hides notice', { generationLevel: GENERATION_LEVEL.ORIGINAL, targetLanguage: 'none', docPath: 'docs/guide.md' }, false],
      ['code_lesson and enhanced hide notice', { generationLevel: GENERATION_LEVEL.CODE_LESSON, targetLanguage: 'zh-CN', docPath: 'chapters/01.mdx' }, false],
    ];
    for (const [label, input, expected] of noticeCases) {
      expect(shouldShowChapterDegradedNotice(input), label).toBe(expected);
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opengits-scoped-'));
    try {
      expect(await isScopedLocalArchive(tmpRoot)).toBe(false);
      fs.writeFileSync(path.join(tmpRoot, SCOPED_UNPACK_MARKER), 'outline:test\n', 'utf-8');
      expect(await isScopedLocalArchive(tmpRoot)).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resolveTheme / themeToColorScheme / applyThemeToDom 与 THEME_INIT_SCRIPT 主题首帧同步闭环', () => {
    const resolveCases: Array<[unknown, 'vercel' | 'dark']> = [
      ['dark', 'dark'],
      ['vercel', 'vercel'],
      [null, DEFAULT_THEME],
      [undefined, DEFAULT_THEME],
      ['parchment', DEFAULT_THEME],
      ['', DEFAULT_THEME],
    ];
    for (const [raw, expected] of resolveCases) {
      expect(resolveTheme(raw)).toBe(expected);
    }
    expect(themeToColorScheme('dark')).toBe('dark');
    expect(themeToColorScheme('vercel')).toBe('light');

    const createDomEnv = (initialTheme: 'vercel' | 'dark', initialStored: string | null) => {
      const attrs = new Map<string, string>([['data-theme', initialTheme]]);
      const classes = new Set<string>(initialTheme === 'dark' ? ['dark'] : []);
      const bodyAttrs = new Map<string, string>([['data-theme', 'vercel']]);
      const bodyClasses = new Set<string>(['dark']);
      const metaAttrs = new Map<string, string>([['content', themeToColorScheme(initialTheme)]]);
      const storage = new Map<string, string>();
      if (initialStored !== null) storage.set(STORAGE_KEYS.THEME_PREFERENCE, initialStored);
      let cookieStr = '';

      const makeClassList = (set: Set<string>) => ({
        add: (...items: string[]) => items.forEach((c) => set.add(c)),
        remove: (...items: string[]) => items.forEach((c) => set.delete(c)),
        toggle: (cls: string, force?: boolean) => {
          const shouldAdd = force !== undefined ? force : !set.has(cls);
          if (shouldAdd) set.add(cls);
          else set.delete(cls);
          return shouldAdd;
        },
        contains: (cls: string) => set.has(cls),
      });

      const root = {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        classList: makeClassList(classes),
        style: { colorScheme: '' },
      };
      const body = {
        setAttribute: (k: string, v: string) => bodyAttrs.set(k, v),
        getAttribute: (k: string) => bodyAttrs.get(k) ?? null,
        removeAttribute: (k: string) => bodyAttrs.delete(k),
        classList: makeClassList(bodyClasses),
      };
      const meta = {
        setAttribute: (k: string, v: string) => metaAttrs.set(k, v),
        getAttribute: (k: string) => metaAttrs.get(k) ?? null,
      };
      const doc = {
        documentElement: root,
        body,
        querySelector: (sel: string) => (sel === 'meta[name="color-scheme"]' ? meta : null),
        get cookie() {
          return cookieStr;
        },
        set cookie(val: string) {
          cookieStr = val;
        },
      };
      const ls = {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
      };
      return { doc, ls, root, body, meta, getCookie: () => cookieStr };
    };

    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevLs = g.localStorage;
    try {
      // 1) applyThemeToDom 同步 <html>、清理 <body> 残留、更新 <meta>、写入 localStorage 与 cookie
      const env = createDomEnv('vercel', null);
      g.document = env.doc;
      g.localStorage = env.ls;

      applyThemeToDom('dark');
      expect(env.root.getAttribute('data-theme')).toBe('dark');
      expect(env.root.classList.contains('dark')).toBe(true);
      expect(env.root.style.colorScheme).toBe('dark');
      expect(env.body.getAttribute('data-theme')).toBeNull();
      expect(env.body.classList.contains('dark')).toBe(false);
      expect(env.meta.getAttribute('content')).toBe('dark');
      expect(env.ls.getItem(STORAGE_KEYS.THEME_PREFERENCE)).toBe('dark');
      expect(env.getCookie()).toContain(`${STORAGE_KEYS.THEME_COOKIE}=dark`);

      applyThemeToDom('vercel');
      expect(env.root.getAttribute('data-theme')).toBe('vercel');
      expect(env.root.classList.contains('dark')).toBe(false);
      expect(env.root.style.colorScheme).toBe('light');
      expect(env.meta.getAttribute('content')).toBe('light');
      expect(env.ls.getItem(STORAGE_KEYS.THEME_PREFERENCE)).toBe('vercel');
      expect(env.getCookie()).toContain(`${STORAGE_KEYS.THEME_COOKIE}=vercel`);

      // 2) <head> 同步内联脚本矩阵：覆盖老用户纯 localStorage、SSR cookie 直出、跨态纠正
      const scriptCases: Array<{
        label: string;
        stored: string | null;
        ssrTheme: 'vercel' | 'dark';
        expectedTheme: 'vercel' | 'dark';
        expectedDark: boolean;
        expectedScheme: 'light' | 'dark';
      }> = [
        {
          label: 'localStorage=dark overrides SSR vercel default and backfills cookie',
          stored: 'dark',
          ssrTheme: 'vercel',
          expectedTheme: 'dark',
          expectedDark: true,
          expectedScheme: 'dark',
        },
        {
          label: 'missing localStorage preserves SSR dark from cookie',
          stored: null,
          ssrTheme: 'dark',
          expectedTheme: 'dark',
          expectedDark: true,
          expectedScheme: 'dark',
        },
        {
          label: 'localStorage=vercel overrides stale SSR dark cookie',
          stored: 'vercel',
          ssrTheme: 'dark',
          expectedTheme: 'vercel',
          expectedDark: false,
          expectedScheme: 'light',
        },
        {
          label: 'unknown localStorage falls back to default light theme',
          stored: 'parchment',
          ssrTheme: 'vercel',
          expectedTheme: 'vercel',
          expectedDark: false,
          expectedScheme: 'light',
        },
      ];

      for (const tc of scriptCases) {
        const sEnv = createDomEnv(tc.ssrTheme, tc.stored);
        g.document = sEnv.doc;
        g.localStorage = sEnv.ls;
        new Function(THEME_INIT_SCRIPT)();
        expect(sEnv.root.getAttribute('data-theme'), tc.label).toBe(tc.expectedTheme);
        expect(sEnv.root.classList.contains('dark'), tc.label).toBe(tc.expectedDark);
        expect(sEnv.root.style.colorScheme, tc.label).toBe(tc.expectedScheme);
        expect(sEnv.meta.getAttribute('content'), tc.label).toBe(tc.expectedScheme);
        expect(sEnv.getCookie(), tc.label).toContain(`${STORAGE_KEYS.THEME_COOKIE}=${tc.expectedTheme}`);
      }
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
      if (prevLs === undefined) delete g.localStorage;
      else g.localStorage = prevLs;
    }
  });
});
