import { describe, it, expect, vi } from 'vitest';
import {
  buildSkeleton,
  skeletonHashOf,
  isSkeletonComparable,
  normalizePrompt,
  buildEditionFingerprint,
  extractSkeletonPaths,
  SKELETON_MAX_PATHS,
  SKELETON_MIN_PATHS,
} from '@/lib/similarity/features';
import { runSourceDetection } from '@/lib/similarity/service';
import { summarizeDetection } from '@/lib/similarity/cluster';

const blob = (path: string) => ({ path, type: 'blob' });
const tree = (paths: string[]) => paths.map(blob);

describe('buildSkeleton（骨架归一化）', () => {
  it('确定性：同路径集合（顺序/大小写不同）产出同骨架', () => {
    const a = buildSkeleton(['src/A.ts', 'docs/b.md']);
    const b = buildSkeleton(['docs/B.md', 'SRC/a.ts']);
    expect(a).toBe(b);
  });

  it('截断：超过上限的路径集合按字典序保留前 N 条', () => {
    const many = Array.from({ length: SKELETON_MAX_PATHS + 50 }, (_, i) => `src/f${String(i).padStart(4, '0')}.ts`);
    const skeleton = buildSkeleton(many);
    expect(skeleton.split('\n')).toHaveLength(SKELETON_MAX_PATHS);
  });

  it('hash 稳定：同骨架同 hash，异骨架异 hash', () => {
    expect(skeletonHashOf('a\nb')).toBe(skeletonHashOf('a\nb'));
    expect(skeletonHashOf('a\nb')).not.toBe(skeletonHashOf('a\nc'));
  });
});

describe('isSkeletonComparable（小仓跳过）', () => {
  it('低于最小路径数返回 false（脚手架小仓防误报）', () => {
    const small = Array.from({ length: SKELETON_MIN_PATHS - 1 }, (_, i) => `p${i}.ts`).join('\n');
    expect(isSkeletonComparable(small)).toBe(false);
    expect(isSkeletonComparable('')).toBe(false);
  });

  it('达到最小路径数返回 true', () => {
    const enough = Array.from({ length: SKELETON_MIN_PATHS }, (_, i) => `src/p${i}.ts`).join('\n');
    expect(isSkeletonComparable(enough)).toBe(true);
  });
});

describe('extractSkeletonPaths（内容路径过滤）', () => {
  it('剔除非内容目录与非常见扩展，保留 blob', () => {
    const paths = extractSkeletonPaths([
      blob('src/index.ts'),
      blob('docs/guide.md'),
      blob('node_modules/pkg/index.js'),
      blob('assets/logo.png'),
      blob('binary.bin'),
      { path: 'src/dir', type: 'tree' },
    ]);
    expect(paths).toEqual(['src/index.ts', 'docs/guide.md']);
  });
});

describe('buildEditionFingerprint（讲法指纹）', () => {
  it('同配方同指纹', () => {
    const a = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉 JS', targetLanguage: 'zh-CN', teachingDepth: 'standard' });
    const b = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉 JS', targetLanguage: 'zh-CN', teachingDepth: 'standard' });
    expect(a).toBe(b);
  });

  it('语气词重写版同指纹（normalizePrompt 去空白标点）', () => {
    const a = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉 JS，请对照讲解！' });
    const b = buildEditionFingerprint({ preset: 'analogy', customPrompt: '我熟悉js 请对照讲解' });
    expect(a).toBe(b);
  });

  it('任一要素实质变化即不同指纹', () => {
    const base = { preset: 'analogy', customPrompt: 'x', targetLanguage: 'zh-CN', teachingDepth: 'standard' };
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, preset: 'deep' }));
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, customPrompt: 'y' }));
    expect(buildEditionFingerprint(base)).not.toBe(buildEditionFingerprint({ ...base, targetLanguage: 'en-US' }));
  });
});

describe('normalizePrompt', () => {
  it('小写 + 去空白 + 去标点符号', () => {
    expect(normalizePrompt('Hello, World! 你好？')).toBe('helloworld你好');
  });
});

describe('runSourceDetection（编排合并）', () => {
  it('检测器异常被隔离：不抛错、返回空结果', async () => {
    const { SOURCE_DETECTORS } = await import('@/lib/similarity/registry');
    const bad = [...SOURCE_DETECTORS, {
      key: 'bad',
      extract: async () => { throw new Error('boom'); },
      match: async () => [],
    }];
    vi.spyOn(await import('@/lib/similarity/registry'), 'SOURCE_DETECTORS', 'get').mockReturnValue(bad);
    const result = await runSourceDetection({ owner: 'o', repo: 'r', branch: 'main' });
    expect(result.matches).toEqual([]);
    expect(result.best).toBeNull();
    vi.restoreAllMocks();
  });

  it('无可用信号（无 gitSha/树/upstream）返回空结果且不报错', async () => {
    const result = await runSourceDetection({ owner: 'o', repo: 'r', branch: 'main' });
    expect(result.best).toBeNull();
    expect(result.features).toEqual([]);
  });
});

describe('summarizeDetection（展示摘要）', () => {
  it('无命中返回 null；有命中产出百分比与方法', () => {
    expect(summarizeDetection({ matches: [], best: null, features: [] })).toBeNull();
    const summary = summarizeDetection({
      matches: [],
      best: { detectorKey: 'skeleton-trgm', repositoryId: '1', owner: 'a', repo: 'b', similarity: 0.934 },
      features: [],
    });
    expect(summary).toEqual({ owner: 'a', repo: 'b', similarity: 0.93, method: 'skeleton-trgm' });
  });
});
