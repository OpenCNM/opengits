import { describe, it, expect } from 'vitest';
import { canonicalizeRepo } from '@/lib/repo-dedup';
import { resolveEditionForKey } from '@/lib/edition';
import { isSkeletonComparable, buildSkeleton, SKELETON_MIN_PATHS, extractSkeletonPaths } from '@/lib/similarity/features';
import { computeRecommendationScore, mergeMcpHealth } from '@/lib/recommendation/score';
import { gitShaDetector } from '@/lib/similarity/detectors/git-sha';

describe('Multi-Edition & Repository Ingest Guards', () => {
  it('BUG-01: canonicalizeRepo 强制小写归一化防御大小写逃逸', () => {
    const res1 = canonicalizeRepo('FastAPI', 'FastAPI');
    expect(res1.owner).toBe('fastapi');
    expect(res1.repo).toBe('fastapi');

    const res2 = canonicalizeRepo('owner-name', 'repo-name.git');
    expect(res2.owner).toBe('owner-name');
    expect(res2.repo).toBe('repo-name');
  });

  it('Task 1: resolveEditionForKey 参数解析与空白防御', () => {
    // 默认空讲法
    expect(resolveEditionForKey({})).toBe('');
    expect(resolveEditionForKey({ edition: '' })).toBe('');
    expect(resolveEditionForKey({ edition: '   ' })).toBe('');

    // 指定讲法
    expect(resolveEditionForKey({ edition: 'ed_custom1' })).toBe('ed_custom1');

    // 衍生新讲法
    const created = resolveEditionForKey({ createEdition: true });
    expect(created.startsWith('ed_')).toBe(true);
    expect(created.length).toBe(11); // 'ed_' + 8 hex chars
  });

  it('BUG-08: 骨架与特征提取对微型模板项目的最小路径门禁防护', () => {
    // 只有 1~2 个模板脚手架文件时，isSkeletonComparable 应拒绝比对
    const tinySkeleton = buildSkeleton(['README.md', 'package.json']);
    expect(isSkeletonComparable(tinySkeleton)).toBe(false);

    // 达到或超过 SKELETON_MIN_PATHS 时，允许比对
    const validPaths = Array.from({ length: SKELETON_MIN_PATHS }, (_, i) => `src/file_${i}.ts`);
    const validSkeleton = buildSkeleton(validPaths);
    expect(isSkeletonComparable(validSkeleton)).toBe(true);
  });

  it('BUG-08 补全: git-sha 门禁对 0 有效路径（纯非内容文件模板仓）同样跳过单一 sha 命中', async () => {
    // 全部为非内容文件（无允许扩展名）→ extractSkeletonPaths 过滤后为 0 路径：
    // 初始 commit sha 碰撞的空壳模板仓不得凭单一 sha 误归簇
    const emptyShellTree = [
      { path: 'LICENSE', type: 'blob' },
      { path: '.gitignore', type: 'blob' },
    ];
    expect(extractSkeletonPaths(emptyShellTree)).toHaveLength(0);
    const feature = await gitShaDetector.extract?.({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      gitSha: 'a'.repeat(40),
      treeNodes: emptyShellTree,
    });
    expect(feature).toBeNull();

    // 对照组：无树信息（treeNodes 缺席）保持既有行为——仍产出 sha 特征
    const noTree = await gitShaDetector.extract?.({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      gitSha: 'a'.repeat(40),
    });
    expect(noTree).toMatchObject({ detectorKey: 'git-sha', gitSha: 'a'.repeat(40) });

    // 零树化下沉：existingSignature.skeleton 路径少于门禁时同样拦截空壳模板 commit 碰撞
    const sidecarEmptySignature = await gitShaDetector.extract?.({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      gitSha: 'a'.repeat(40),
      treeNodes: null,
      existingSignature: { skeleton: '', skeletonHash: 'd41d8cd98f00b204e9800998ecf8427e' },
    });
    expect(sidecarEmptySignature).toBeNull();
  });

  it('BUG-04 补全: mergeMcpHealth 聚合近期调用求和、盲区率按调用数加权', () => {
    const merged = mergeMcpHealth([
      { recentCalls: 100, blindRate: 0.1 },
      { recentCalls: 300, blindRate: 0.5 },
      null,
      undefined,
    ]);
    expect(merged.recentCalls).toBe(400);
    // (100×0.1 + 300×0.5) / 400 = 160/400 = 0.4
    expect(merged.blindRate).toBeCloseTo(0.4, 10);

    // 全空输入 → 零健康（无近期调用，盲区率 0）
    expect(mergeMcpHealth([])).toEqual({ recentCalls: 0, blindRate: 0 });

    // 聚合健康参与打分：mcpValue 分量随近期调用增长，与单讲法卡口径一致
    const base = computeRecommendationScore({
      savedCount: 5, helpfulCount: 0, mcpCallCount: 50, updatedAt: new Date(),
    }, { recentCalls: 0, blindRate: 0 });
    const withHealth = computeRecommendationScore({
      savedCount: 5, helpfulCount: 0, mcpCallCount: 50, updatedAt: new Date(),
    }, merged);
    expect(withHealth.breakdown.mcpValue).toBeGreaterThan(base.breakdown.mcpValue);
  });

  it('BUG-04: 聚合主卡推荐分能够正确反映多讲法累加后的热度红利', () => {
    const singleEditionScore = computeRecommendationScore({
      savedCount: 1,
      helpfulCount: 0,
      mcpCallCount: 0,
      updatedAt: new Date(),
    });

    const aggregatedScore = computeRecommendationScore({
      savedCount: 1 + 20,
      helpfulCount: 0 + 10,
      mcpCallCount: 0 + 100,
      updatedAt: new Date(),
    });

    // 累加后的推荐分与社区分应显著高于单版本初值
    expect(aggregatedScore.total).toBeGreaterThan(singleEditionScore.total);
    expect(aggregatedScore.breakdown.community).toBeGreaterThan(singleEditionScore.breakdown.community);
  });
});
