import { describe, it, expect } from 'vitest';

import { buildHeuristicVersions, buildVersionCandidates } from '@/lib/scout/pipeline/version-candidates';
import { DEFAULT_METADATA } from '@/lib/scout/pipeline/metadata-ai';
import type { GitHubNode } from '@/engine/fetcher';
import type { DirVerdict } from '@/lib/dir-verdict';

function md(path: string): GitHubNode {
  return { path, mode: '100644', type: 'blob', sha: 's', url: `https://example/${path}` };
}

const markdownFiles: GitHubNode[] = [
  md('docs/a.md'),
  md('docs/b/c.md'),
  md('docs/d.md'),
  md('guide/e.md'),
  md('guide/f.md'),
  md('guide/g.md'),
  md('advanced/h.md'),
  md('README.md'),
];

const heuristicInput = {
  repoProfileTextRoot: 'docs/',
  repoProfileTranslationRoots: ['zh-CN/'],
  markdownFiles,
  inspectionFilePath: 'tutorials/' as string | undefined,
};

const primaryVerdict: DirVerdict = {
  primaryRoot: 'guide/',
  candidates: [
    { dir: 'guide/', lang: null, role: 'primary', confidence: 0.9 },
    { dir: 'advanced/', lang: null, role: 'auxiliary', confidence: 0.5 },
  ],
};

describe('scout version-candidates knownPrefixes 与 AI 裁决解耦', () => {
  it('1.10.1.1 DEFAULT_METADATA 零失败保障: 提供稳定的预设分类与打标字段', () => {
    expect(DEFAULT_METADATA).toBeDefined();
    expect(DEFAULT_METADATA.aiCategory).toBe('Others');
    expect(DEFAULT_METADATA.aiTags).toBe('');
    expect(DEFAULT_METADATA.paradigm).toBe('Engineering');
    expect(Array.isArray(DEFAULT_METADATA.parallelTracks)).toBe(true);
    expect(DEFAULT_METADATA.parallelTracks).toHaveLength(0);
  });

  it('1.10.2.1 knownPrefixes 不依赖 verdict: 启发式单独构建与完整构建结果一致', () => {
    const heuristic = buildHeuristicVersions(heuristicInput);
    const withVerdict = buildVersionCandidates({ ...heuristicInput, verdict: primaryVerdict });
    const withoutVerdict = buildVersionCandidates({ ...heuristicInput, verdict: null });

    expect([...heuristic.knownPrefixes].sort()).toEqual([...withVerdict.knownPrefixes].sort());
    expect([...heuristic.knownPrefixes].sort()).toEqual([...withoutVerdict.knownPrefixes].sort());
  });

  it('1.10.2.1 knownPrefixes 包含正文根/翻译根/高频顶层目录与 URL 子路径', () => {
    const { knownPrefixes } = buildHeuristicVersions(heuristicInput);

    expect(knownPrefixes.has('docs/')).toBe(true);
    expect(knownPrefixes.has('zh-CN/')).toBe(true);
    expect(knownPrefixes.has('guide/')).toBe(true);
    expect(knownPrefixes.has('tutorials/')).toBe(true);
    // 低频目录(< 3 个 md 文件)与根目录不计入
    expect(knownPrefixes.has('advanced/')).toBe(false);
  });

  it('1.10.3.1 探测管道全链零抛错降级: 遇到空输入或异常候选时平滑返回安全空候选', () => {
    const emptyResult = buildVersionCandidates({
      repoProfileTextRoot: '',
      repoProfileTranslationRoots: [],
      markdownFiles: [],
      verdict: null,
    });
    expect(emptyResult.versions).toHaveLength(1);
    expect(emptyResult.versions[0].prefix).toBe('');
    expect(emptyResult.knownPrefixes.has('')).toBe(true);
  });

  it('verdict 合并只影响 versions:主目录裁决进入候选,辅助目录被忽略', () => {
    const heuristic = buildHeuristicVersions(heuristicInput);
    const { versions } = buildVersionCandidates({ ...heuristicInput, verdict: primaryVerdict });

    expect(versions.some((v) => v.prefix === 'guide/')).toBe(true);
    expect(versions.some((v) => v.prefix === 'advanced/')).toBe(false);
    // 启发式候选不被丢弃
    for (const v of heuristic.heuristicVersions) {
      expect(versions.some((m) => m.prefix === v.prefix)).toBe(true);
    }
  });
});
