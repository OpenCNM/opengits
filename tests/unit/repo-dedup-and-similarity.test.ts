import { describe, it, expect, vi } from 'vitest';
import { canonicalizeRepo } from '@/lib/repo-dedup';
import { resolveEditionForKey } from '@/lib/edition';
import {
  isSkeletonComparable,
  buildSkeleton,
  SKELETON_MIN_PATHS,
  extractSkeletonPaths,
  skeletonHashOf,
  normalizePrompt,
  buildEditionFingerprint,
  SKELETON_MAX_PATHS,
} from '@/lib/similarity/features';
import { computeRecommendationScore, mergeMcpHealth, type RecommendationInput } from '@/lib/recommendation/score';
import { gitShaDetector } from '@/lib/similarity/detectors/git-sha';
import { WEB_DOC_OWNER } from '@/lib/constants';
import {
  extractWebDocOrigin,
  isGenericWebDocTitle,
  isNativeWebDocMirror,
  isWebDocRepository,
  resolveRepositoryDisplayName,
} from '@/lib/repository-origin';
import { ENGINE_CONFIG } from '@/lib/config';
import { runSourceDetection } from '@/lib/similarity/service';
import { summarizeDetection } from '@/lib/similarity/cluster';

describe('multi-edition-guard & recommendation', () => {
  it('canonicalizeRepo & resolveEditionForKey 大小写归一与讲法键防重', () => {
    expect(canonicalizeRepo('FastAPI', 'FastAPI')).toEqual({ owner: 'fastapi', repo: 'fastapi' });
    expect(canonicalizeRepo('owner-name', 'repo-name.git')).toEqual({ owner: 'owner-name', repo: 'repo-name' });

    expect(resolveEditionForKey({})).toBe('');
    expect(resolveEditionForKey({ edition: '   ' })).toBe('');
    expect(resolveEditionForKey({ edition: 'ed_custom1' })).toBe('ed_custom1');
    expect(resolveEditionForKey({ createEdition: true })).toMatch(/^ed_[0-9a-f]{8}$/);
  });

  it('git-sha 门禁拦截空壳模板仓并在无树信息时保留特征', async () => {
    const emptyShellTree = [
      { path: 'LICENSE', type: 'blob' },
      { path: '.gitignore', type: 'blob' },
    ];
    expect(extractSkeletonPaths(emptyShellTree)).toHaveLength(0);
    expect(await gitShaDetector.extract?.({ owner: 'o', repo: 'r', branch: 'main', gitSha: 'a'.repeat(40), treeNodes: emptyShellTree })).toBeNull();
    expect(await gitShaDetector.extract?.({ owner: 'o', repo: 'r', branch: 'main', gitSha: 'a'.repeat(40) })).toMatchObject({
      detectorKey: 'git-sha',
      gitSha: 'a'.repeat(40),
    });
    expect(
      await gitShaDetector.extract?.({
        owner: 'o',
        repo: 'r',
        branch: 'main',
        gitSha: 'a'.repeat(40),
        treeNodes: null,
        existingSignature: { skeleton: '', skeletonHash: 'd41d8cd98f00b204e9800998ecf8427e' },
      })
    ).toBeNull();
  });

  it('mergeMcpHealth 加权聚合与 computeRecommendationScore 多讲法/社区/MCP/新鲜度评分', () => {
    const merged = mergeMcpHealth([{ recentCalls: 100, blindRate: 0.1 }, { recentCalls: 300, blindRate: 0.5 }, null, undefined]);
    expect(merged.recentCalls).toBe(400);
    expect(merged.blindRate).toBeCloseTo(0.4, 10);
    expect(mergeMcpHealth([])).toEqual({ recentCalls: 0, blindRate: 0 });

    const R = ENGINE_CONFIG.recommendation;
    const repoInput = (overrides: Partial<RecommendationInput> = {}): RecommendationInput => ({
      savedCount: 0,
      mcpCallCount: 0,
      updatedAt: new Date(),
      reviewPipelineTotal: null,
      reviewLlmScore: null,
      ...overrides,
    });

    expect(computeRecommendationScore(repoInput()).total).toBe(R.legacyNeutralBaseline + R.freshnessMax);
    expect(computeRecommendationScore(repoInput({ savedCount: 10 })).breakdown.community).toBe(R.communityMax);
    expect(computeRecommendationScore(repoInput({ mcpCallCount: 25 }), { recentCalls: 12, blindRate: 0 }).breakdown.mcpValue).toBe(
      R.mcpLifetimeMax + R.mcpRecentMax
    );
    expect(computeRecommendationScore(repoInput({ mcpCallCount: 25 }), { recentCalls: 12, blindRate: 0.8 }).breakdown.mcpValue).toBe(
      R.mcpLifetimeMax + R.mcpRecentMax - R.blindPenaltyMax
    );
    expect(computeRecommendationScore(repoInput({ reviewPipelineTotal: 90, reviewLlmScore: 88 })).breakdown.contentBaseline).toBeGreaterThan(
      computeRecommendationScore(repoInput()).breakdown.contentBaseline
    );

    const age = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);
    expect(computeRecommendationScore(repoInput({ updatedAt: age(89) })).breakdown.freshness).toBe(R.freshnessMax);
    const mid = computeRecommendationScore(repoInput({ updatedAt: age((R.freshWindowDays + R.staleWindowDays) / 2) })).breakdown.freshness;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(R.freshnessMax);
    expect(computeRecommendationScore(repoInput({ updatedAt: age(R.staleWindowDays + 10) })).breakdown.freshness).toBe(0);
    expect(computeRecommendationScore(repoInput({ savedCount: 4, mcpCallCount: 30 })).total).toBeGreaterThan(
      computeRecommendationScore(repoInput()).total
    );
  });
});

describe('repository-origin', () => {
  it('isWebDocRepository & isNativeWebDocMirror 镜像与衍生讲法判定', () => {
    expect(isWebDocRepository({ owner: WEB_DOC_OWNER, repo: 'eve-dev' })).toBe(true);
    expect(isWebDocRepository({ owner: 'org', repo: 'docs', category: 'Web Docs' })).toBe(true);
    expect(isWebDocRepository({ owner: 'custom', repo: 'site', repoProfile: { sourceType: 'web' } })).toBe(true);
    expect(isWebDocRepository({ owner: 'vercel', repo: 'next.js', category: 'Frontend' })).toBe(false);
    expect(isWebDocRepository(null)).toBe(false);

    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: '' })).toBe(true);
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: '   ' })).toBe(true);
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: 'quick-start-guide' })).toBe(false);
    expect(isNativeWebDocMirror({ owner: 'vercel', repo: 'next.js', edition: '' })).toBe(false);
  });

  it('resolveRepositoryDisplayName & extractWebDocOrigin & isGenericWebDocTitle Style B 显示名称与通用标题回退', () => {
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'web-eve-dev',
        repoProfile: { sourceType: 'web', siteTitle: 'Eve Docs', originalUrl: 'https://eve.dev/docs/getting-started' },
      })
    ).toBe('Eve Docs');
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'vite-dev',
        title: 'Features \u200b',
        repoProfile: { sourceType: 'web', siteTitle: 'Features \u200b', originalUrl: 'https://vite.dev/guide/features' },
      })
    ).toBe('vite.dev');
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'svelte-dev',
        repoProfile: { sourceType: 'web', siteTitle: 'Svelte \u200b', originalUrl: 'https://svelte.dev/docs/svelte' },
      })
    ).toBe('Svelte');
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'coss-com',
        title: 'Introduction',
        repoProfile: { sourceType: 'web', siteTitle: 'Introduction', originalUrl: 'https://www.coss.com/ui/docs' },
      })
    ).toBe('coss.com');
    expect(resolveRepositoryDisplayName({ owner: 'vercel', repo: 'ai' })).toBe('vercel/ai');

    expect(extractWebDocOrigin({ repoProfile: { sourceType: 'web', originalUrl: 'https://www.coss.com/ui/docs/' } })).toEqual({
      host: 'coss.com',
      endpoint: 'coss.com/ui/docs',
    });
    expect(extractWebDocOrigin({ repoProfile: { sourceType: 'web', originalUrl: 'invalid' } })).toEqual({ host: '', endpoint: '' });
    expect(isGenericWebDocTitle('Introduction')).toBe(true);
    expect(isGenericWebDocTitle('快速开始')).toBe(true);
    expect(isGenericWebDocTitle('Features \u200b', 'https://vite.dev/guide/features')).toBe(true);
    expect(isGenericWebDocTitle('coss ui')).toBe(false);
  });
});

describe('similarity', () => {
  it('buildSkeleton / isSkeletonComparable / extractSkeletonPaths / skeletonHashOf 骨架归一与截断', () => {
    expect(buildSkeleton(['src/A.ts', 'docs/b.md'])).toBe(buildSkeleton(['docs/B.md', 'SRC/a.ts']));
    const many = Array.from({ length: SKELETON_MAX_PATHS + 50 }, (_, i) => `src/f${String(i).padStart(4, '0')}.ts`);
    expect(buildSkeleton(many).split('\n')).toHaveLength(SKELETON_MAX_PATHS);
    expect(skeletonHashOf('a\nb')).toBe(skeletonHashOf('a\nb'));
    expect(skeletonHashOf('a\nb')).not.toBe(skeletonHashOf('a\nc'));

    expect(isSkeletonComparable(buildSkeleton(['README.md', 'package.json']))).toBe(false);
    expect(isSkeletonComparable('')).toBe(false);
    expect(isSkeletonComparable(buildSkeleton(Array.from({ length: SKELETON_MIN_PATHS }, (_, i) => `src/p${i}.ts`)))).toBe(true);

    expect(
      extractSkeletonPaths([
        { path: 'src/index.ts', type: 'blob' },
        { path: 'docs/guide.md', type: 'blob' },
        { path: 'node_modules/pkg/index.js', type: 'blob' },
        { path: 'assets/logo.png', type: 'blob' },
        { path: 'src/dir', type: 'tree' },
      ])
    ).toEqual(['src/index.ts', 'docs/guide.md']);
  });

  it('buildEditionFingerprint & normalizePrompt 讲法指纹等价与要素敏感', () => {
    expect(normalizePrompt('Hello, World! 你好？')).toBe('helloworld你好');
    const a = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉 JS，请对照讲解！' });
    const b = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉js 请对照讲解' });
    expect(a).toBe(b);

    const base = { preset: 'analogy', customPrompt: 'x', targetLanguage: 'zh-CN', teachingDepth: 'standard' };
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, preset: 'deep' }));
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, customPrompt: 'y' }));
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, targetLanguage: 'en-US' }));
  });

  it('runSourceDetection 故障隔离与 summarizeDetection 摘要映射', async () => {
    const empty = await runSourceDetection({ owner: 'o', repo: 'r', branch: 'main' });
    expect(empty.best).toBeNull();
    expect(empty.features).toEqual([]);

    const reg = await import('@/lib/similarity/registry');
    vi.spyOn(reg, 'SOURCE_DETECTORS', 'get').mockReturnValue([
      ...reg.SOURCE_DETECTORS,
      { key: 'bad', extract: async () => { throw new Error('boom'); }, match: async () => [] },
    ]);
    const isolated = await runSourceDetection({ owner: 'o', repo: 'r', branch: 'main' });
    expect(isolated.matches).toEqual([]);
    expect(isolated.best).toBeNull();
    vi.restoreAllMocks();

    expect(summarizeDetection({ matches: [], best: null, features: [] })).toBeNull();
    expect(
      summarizeDetection({
        matches: [],
        best: { detectorKey: 'skeleton-trgm', repositoryId: '1', owner: 'a', repo: 'b', similarity: 0.934 },
        features: [],
      })
    ).toEqual({ owner: 'a', repo: 'b', similarity: 0.93, method: 'skeleton-trgm' });
  });
});
