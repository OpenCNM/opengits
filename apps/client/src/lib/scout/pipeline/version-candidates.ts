import type { GitHubNode } from '@/engine/fetcher';
import { isNonContentDir } from '@/engine/language-map';
import { DirVerdict, mergeVerdictIntoVersions, VersionEntry } from '@/lib/dir-verdict';
import { SUBDIR_TEXT_CAP_BYTES } from '@/lib/config';
import { ESTIMATED_TOKENS_PER_BYTE, TOP_DIR_MIN_MARKDOWN_COUNT } from './constants';
import { ScoutVersionCandidate } from './types';

export interface VersionCandidateInput {
  repoProfileTextRoot: string | null;
  repoProfileTranslationRoots: string[];
  markdownFiles: GitHubNode[];
  /** URL 命中的子路径前缀（resourceType=tree 时插入首位候选） */
  inspectionFilePath?: string;
  verdict?: DirVerdict | null;
}

/** 首个候选名：有正文根用中文名，否则退回根目录命名 */
const PRIMARY_ROOT_LABEL = 'Root / Main Content';
const TRANSLATION_LABEL_PREFIX = 'Translation';
const SELECTED_SCOPE_LABEL_PREFIX = 'Selected Scope';

/** 首字母大写的展示名（目录名 → 候选名） */
function toDisplayName(dirName: string): string {
  return dirName.charAt(0).toUpperCase() + dirName.slice(1);
}

/**
 * 启发式候选（不含 AI 目录裁决合并）——
 * knownPrefixes 仅由正文根/翻译根/高频顶层目录/URL 子路径决定，与裁决无关；
 * 元数据阶段（scout_metadata）只需 knownPrefixes，可在裁决竞速期间提前启动。
 */
export function buildHeuristicVersions(input: Omit<VersionCandidateInput, 'verdict'>): {
  heuristicVersions: VersionEntry[];
  knownPrefixes: Set<string>;
} {
  const { repoProfileTextRoot, repoProfileTranslationRoots, markdownFiles, inspectionFilePath } = input;

  const heuristicVersions: VersionEntry[] = [];
  const primaryPrefix = repoProfileTextRoot || '';
  const primaryName = repoProfileTextRoot ? `正文内容 (${repoProfileTextRoot})` : PRIMARY_ROOT_LABEL;
  heuristicVersions.push({ name: primaryName, prefix: primaryPrefix });

  if (repoProfileTranslationRoots && repoProfileTranslationRoots.length > 0) {
    for (const root of repoProfileTranslationRoots) {
      if (root !== primaryPrefix) {
        const langName = root.replace(/\/$/, '');
        heuristicVersions.push({ name: `${TRANSLATION_LABEL_PREFIX} (${langName})`, prefix: root });
      }
    }
  }

  const knownPrefixes = new Set(heuristicVersions.map(v => v.prefix));
  const topDirCounts = new Map<string, number>();
  for (const file of markdownFiles) {
    const parts = file.path.split('/');
    if (parts.length > 1) {
      const topDir = parts[0] + '/';
      topDirCounts.set(topDir, (topDirCounts.get(topDir) || 0) + 1);
    }
  }

  for (const [dir, count] of Array.from(topDirCounts.entries())) {
    if (count >= TOP_DIR_MIN_MARKDOWN_COUNT && !knownPrefixes.has(dir) && !dir.startsWith('.')) {
      if (!isNonContentDir(dir)) {
        const dirName = dir.replace(/\/$/, '');
        heuristicVersions.push({ name: toDisplayName(dirName), prefix: dir });
        knownPrefixes.add(dir);
      }
    }
  }

  if (inspectionFilePath) {
    const urlPrefix = inspectionFilePath.endsWith('/') ? inspectionFilePath : `${inspectionFilePath}/`;
    if (!knownPrefixes.has(urlPrefix)) {
      heuristicVersions.unshift({ name: `${SELECTED_SCOPE_LABEL_PREFIX} (${inspectionFilePath})`, prefix: urlPrefix });
      knownPrefixes.add(urlPrefix);
    }
  }

  return { heuristicVersions, knownPrefixes };
}

/**
 * STAGE 3 (候选目录)：启发式定位核心学习目录——
 * 正文根 + 翻译根 + 高频顶层目录，URL 子路径候选置顶；再合并 AI 目录裁决。
 * 返回合并后的候选与已知前缀集合（元数据阶段要用其圈定目录清单）。
 */
export function buildVersionCandidates(input: VersionCandidateInput): {
  versions: VersionEntry[];
  knownPrefixes: Set<string>;
} {
  const { heuristicVersions, knownPrefixes } = buildHeuristicVersions(input);
  return { versions: mergeVerdictIntoVersions(heuristicVersions, input.verdict ?? null), knownPrefixes };
}

/** 为候选目录附加体积统计（文件数 / 字节 / 估算 token / 超限标记） */
export function attachVersionStats(versions: VersionEntry[], markdownFiles: GitHubNode[]): ScoutVersionCandidate[] {
  return versions.map((v) => {
    let files = markdownFiles;
    if (v.prefix !== '') {
      files = markdownFiles.filter((f: GitHubNode) => f.path.startsWith(v.prefix));
    }
    const totalFiles = files.length;
    const totalBytes = files.reduce((acc: number, f: GitHubNode) => acc + (f.size || 0), 0);
    return {
      ...v,
      totalFiles,
      totalBytes,
      sizeMb: (totalBytes / 1024 / 1024).toFixed(1),
      estimatedTokens: Math.ceil(totalBytes * ESTIMATED_TOKENS_PER_BYTE),
      isOversized: totalBytes > SUBDIR_TEXT_CAP_BYTES,
    };
  });
}
