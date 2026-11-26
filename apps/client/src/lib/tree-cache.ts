import path from 'path';
import fs from 'fs-extra';
import { GitHubNode } from '@/engine/fetcher';

const TREE_CACHE_MAX_ENTRIES = parseInt(process.env.TREE_CACHE_MAX_ENTRIES || '10', 10);
const TREE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TREE_DISK_MAX_ENTRIES = 30;
const TREE_DISK_DIR = process.env.TREE_CACHE_DIR || path.join(process.cwd(), 'storage', 'trees');

export type CachedTree = GitHubNode[] & { truncated?: boolean; exclusionReport?: any };

function cloneCachedTree(tree: CachedTree): CachedTree {
  const { truncated, exclusionReport } = tree;
  return Object.assign([...tree], { truncated, exclusionReport }) as CachedTree;
}

interface TreeCacheEntry {
  ts: number;
  tree: CachedTree;
}

const treeCache = new Map<string, TreeCacheEntry>();

function treeCacheKey(owner: string, repo: string, sha: string): string {
  return `tree:${owner}/${repo}@${sha}`;
}

function treeDiskFile(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_@.-]/g, '_');
  return path.join(TREE_DISK_DIR, `${safe}.json`);
}

function persistTreeToDisk(key: string, tree: CachedTree): void {
  void (async () => {
    try {
      await fs.ensureDir(TREE_DISK_DIR);
      const entries = await fs.readdir(TREE_DISK_DIR);
      if (entries.length >= TREE_DISK_MAX_ENTRIES) {
        const statted = await Promise.all(
          entries.map(async (f) => ({ f, mtime: (await fs.stat(path.join(TREE_DISK_DIR, f))).mtimeMs }))
        );
        statted.sort((a, b) => a.mtime - b.mtime);
        for (const { f } of statted.slice(0, statted.length - TREE_DISK_MAX_ENTRIES + 1)) {
          await fs.remove(path.join(TREE_DISK_DIR, f)).catch(() => undefined);
        }
      }
      const { truncated, exclusionReport } = tree as CachedTree;
      await fs.writeFile(treeDiskFile(key), JSON.stringify({
        ts: Date.now(),
        nodes: [...tree],
        meta: { truncated, exclusionReport },
      }));
    } catch {
    }
  })();
}

export async function hydrateTreeFromDisk(owner: string, repo: string, sha: string): Promise<CachedTree | undefined> {
  const key = treeCacheKey(owner, repo, sha);
  try {
    const raw = await fs.readFile(treeDiskFile(key), 'utf8');
    const parsed = JSON.parse(raw) as {
      ts: number;
      nodes: GitHubNode[];
      meta: { truncated?: boolean; exclusionReport?: any };
      tree?: GitHubNode[];
    };
    const nodes = Array.isArray(parsed?.nodes) && parsed.nodes.length > 0 ? parsed.nodes : parsed?.tree;
    if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
    if (Date.now() - parsed.ts > TREE_CACHE_TTL_MS) {
      void fs.remove(treeDiskFile(key)).catch(() => undefined);
      return undefined;
    }
    const tree = Object.assign([...nodes], parsed.meta ?? {}) as CachedTree;
    setCachedTree(owner, repo, sha, tree);
    return cloneCachedTree(tree);
  } catch {
    return undefined;
  }
}

export function getCachedTree(owner: string, repo: string, sha: string): CachedTree | undefined {
  const key = treeCacheKey(owner, repo, sha);
  const entry = treeCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TREE_CACHE_TTL_MS) {
    treeCache.delete(key);
    return undefined;
  }
  return cloneCachedTree(entry.tree);
}

export function setCachedTree(owner: string, repo: string, sha: string, tree: CachedTree): void {
  if (treeCache.size >= TREE_CACHE_MAX_ENTRIES) {
    const oldestKey = [...treeCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldestKey) treeCache.delete(oldestKey);
  }
  const key = treeCacheKey(owner, repo, sha);
  treeCache.set(key, { ts: Date.now(), tree: cloneCachedTree(tree) });
  persistTreeToDisk(key, tree);
}
