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
  /** 显式目录前缀过滤（工作台指定作用域） */
  prefixFilter?: string;
  /** URL 解析出的子路径（resourceType=tree 时并入前缀过滤） */
  filePath?: string;
  inspectionFilePath?: string;
  /** 单文档导入模式：用 filePath 精确收窄文件列表（路由层已把 importScopeMode 解析为布尔值） */
  singleDocMode?: boolean;
}

/** scout 只把 markdown 正文当候选内容（.md/.mdx），比通用 DOC_EXTENSIONS 更窄 */
function isMarkdownDocPath(path: string): boolean {
  const pathLower = path.toLowerCase();
  return pathLower.endsWith('.md') || pathLower.endsWith('.mdx');
}

/**
 * 解析分支当前最新 commit sha（归档缓存查找钥匙）。
 * 失败不阻断 scout——返回 null 走 tree API 路径，hasUpdate 归 null。
 */
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

/**
 * STAGE 2 (下载)：归档优先取全树（一生一次下载 → 0 网络推导 tree），
 * 巨型仓库/归档缺失回退 tree API。
 */
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
      const { archiveDirFor, treeFromArchive } = await import('@/engine/repo-tarball');
      const archiveDir = archiveDirFor(owner, repo, currentSha);
      if (await fs.pathExists(archiveDir)) {
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

/** 归一化前缀：确保以 `/` 结尾，便于 startsWith 圈定目录作用域 */
function normalizeDirPrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : prefix + '/';
}

/** 归一化文档路径目标：小写精确后缀匹配 */
function normalizeDocTarget(path: string): string {
  return path.toLowerCase();
}

/**
 * STAGE 2 (筛选)：从全树收集 markdown 正文，并按显式前缀 / URL 子路径 /
 * 单文档模式逐层收窄作用域。
 */
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
