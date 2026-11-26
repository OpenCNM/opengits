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
  inspectionFilePath?: string;
  verdict?: DirVerdict | null;
}

const PRIMARY_ROOT_LABEL = 'Root / Main Content';
const TRANSLATION_LABEL_PREFIX = 'Translation';
const SELECTED_SCOPE_LABEL_PREFIX = 'Selected Scope';

function toDisplayName(dirName: string): string {
  return dirName.charAt(0).toUpperCase() + dirName.slice(1);
}

// Computes knownPrefixes without waiting for AI verdict so metadata calls can run in parallel.
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

export function buildVersionCandidates(input: VersionCandidateInput): {
  versions: VersionEntry[];
  knownPrefixes: Set<string>;
} {
  const { heuristicVersions, knownPrefixes } = buildHeuristicVersions(input);
  return { versions: mergeVerdictIntoVersions(heuristicVersions, input.verdict ?? null), knownPrefixes };
}

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
