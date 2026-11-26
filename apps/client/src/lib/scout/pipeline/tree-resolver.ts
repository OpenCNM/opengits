import fs from 'fs-extra';
import { Fetcher, GitHubNode } from '@/engine/fetcher';
import { ScoutTree } from './types';
export interface ScopedMarkdown {
  tree: ScoutTree;
  currentSha: string | null;
  archiveUsed: boolean;
  markdownFiles: GitHubNode[];
}

export interface MarkdownScopeOptions {
  prefixFilter?: string;
  filePath?: string;
  inspectionFilePath?: string;
  singleDocMode?: boolean;
}

// Scout restricts candidate docs to .md/.mdx (narrower than DOC_EXTENSIONS).
function isMarkdownDocPath(path: string): boolean {
  const pathLower = path.toLowerCase();
  return pathLower.endsWith('.md') || pathLower.endsWith('.mdx');
}

export async function resolveCurrentSha(
  owner: string,
  repo: string,
  branch: string,
  githubToken?: string
): Promise<string | null> {
  try {
    const { resolveLatestSha } = await import('@/engine/repo-tarball');
    return await resolveLatestSha(owner, repo, branch, githubToken);
  } catch (err) {
    console.warn(`[Scout] Failed to resolve latest sha for ${owner}/${repo}@${branch}`, err);
    return null;
  }
}

export async function resolveScoutTree(
  owner: string,
  repo: string,
  branch: string,
  currentSha: string | null,
  githubToken?: string
): Promise<{ tree: ScoutTree; archiveUsed: boolean }> {
  const fetcher = new Fetcher(owner, repo, branch, githubToken);

  let tree: ScoutTree = [];
  let archiveUsed = false;
  if (currentSha) {
    try {
      const { archiveDirFor, isScopedLocalArchive, treeFromArchive } = await import('@/engine/repo-tarball');
      const archiveDir = archiveDirFor(owner, repo, currentSha);
      if ((await fs.pathExists(archiveDir)) && !(await isScopedLocalArchive(archiveDir))) {
        const localTree = await treeFromArchive(owner, repo, currentSha);
        if (localTree && localTree.length > 0) {
          tree = localTree;
          archiveUsed = true;
        }
      }
    } catch (err) {
      console.warn(`[Scout] Local archive check failed for ${owner}/${repo}, falling back to tree API`, err);
    }
  }

  if (!archiveUsed) {
    tree = await fetcher.getRepoTree(3, currentSha || undefined);
  }

  return { tree, archiveUsed };
}

function normalizeDirPrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : prefix + '/';
}

function normalizeDocTarget(path: string): string {
  return path.toLowerCase();
}

export function collectScopedMarkdownFiles(tree: ScoutTree, opts: MarkdownScopeOptions): GitHubNode[] {
  let markdownFiles = tree.filter((n: GitHubNode) => n.type === 'blob' && isMarkdownDocPath(n.path));

  const effectivePrefixFilter =
    opts.prefixFilter ||
    (!opts.singleDocMode && (opts.inspectionFilePath || opts.filePath)
      ? (opts.filePath || opts.inspectionFilePath)
      : undefined);
  if (effectivePrefixFilter) {
    const prefixNorm = normalizeDirPrefix(effectivePrefixFilter);
    markdownFiles = markdownFiles.filter(
      (n: GitHubNode) => n.path.startsWith(prefixNorm) || n.path.startsWith(effectivePrefixFilter)
    );
  }

  if (opts.singleDocMode && opts.filePath) {
    const normTarget = normalizeDocTarget(opts.filePath);
    const exact = markdownFiles.filter((n: GitHubNode) => normalizeDocTarget(n.path) === normTarget);
    if (exact.length > 0) {
      markdownFiles = exact;
    } else {
      const matched = markdownFiles.filter((n: GitHubNode) => normalizeDocTarget(n.path).endsWith(normTarget));
      if (matched.length > 0) {
        markdownFiles = matched;
      }
    }
  }

  return markdownFiles;
}
