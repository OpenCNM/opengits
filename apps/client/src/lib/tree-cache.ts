// 全树 sha 级缓存：getRepoTree 的确定性产物。
//
// 语义：sha 即内容指纹——同 sha 同 owner/repo 必同树；整个导入流程
// （scout / prefix-outline / ingest / code-ingest）共享同一份树，消除重复 API 调用。
// 与 title-cache/llm-cache 同模式：进程内 Map + TTL + LRU + 深拷贝防串染。
// 另有磁盘持久层（storage/trees，按 key 单文件）：进程重启后首次请求免冷拉取
// （慢链路下一棵 3~4MB 全树要 5~16s，重启不该重新付这个成本）。
//
// 存储结构：GitHubNode[] & { truncated?: boolean; exclusionReport?: any }
// （getRepoTree 返回的数组对象带附加属性，下游读 tree.truncated / tree.exclusionReport）。

import path from 'path';
import fs from 'fs-extra';
import { GitHubNode } from '@/engine/fetcher';

const TREE_CACHE_MAX_ENTRIES = parseInt(process.env.TREE_CACHE_MAX_ENTRIES || '10', 10);
const TREE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天（sha 不可变）
/** 磁盘持久层上限（条）：3~4MB/条，30 条 ≈ 100MB 量级；按 mtime 淘汰最旧 */
const TREE_DISK_MAX_ENTRIES = 30;
const TREE_DISK_DIR = process.env.TREE_CACHE_DIR || path.join(process.cwd(), 'storage', 'trees');

/** getRepoTree 的完整返回类型：数组 + 附加属性 */
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

/** 缓存键：tree:owner/repo@sha（仅本模块内部消费） */
function treeCacheKey(owner: string, repo: string, sha: string): string {
  return `tree:${owner}/${repo}@${sha}`;
}

/** 磁盘文件名：owner__repo__sha.json（段内字符已被 assertSafe 级约束，保守再滤一次） */
function treeDiskFile(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_@.-]/g, '_');
  return path.join(TREE_DISK_DIR, `${safe}.json`);
}

/** 落盘（fire-and-forget：在 API 响应路径上不阻塞；失败静默——磁盘层只是优化） */
function persistTreeToDisk(key: string, tree: CachedTree): void {
  void (async () => {
    try {
      await fs.ensureDir(TREE_DISK_DIR);
      // 目录条目超限 → 按 mtime 删最旧（磁盘 LRU，与内存 LRU 独立）
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
      // 数组的附加属性（truncated/exclusionReport）不参与 JSON 数组序列化，拆开存
      const { truncated, exclusionReport } = tree as CachedTree;
      await fs.writeFile(treeDiskFile(key), JSON.stringify({
        ts: Date.now(),
        nodes: [...tree],
        meta: { truncated, exclusionReport },
      }));
    } catch {
      // 磁盘不可用/写失败：静默（内存缓存仍然生效）
    }
  })();
}

/**
 * 磁盘回填：内存 miss 时由调用方（fetcher.getRepoTree）await——
 * 命中则回填内存并返回树；文件不存在/损坏/过期返回 undefined（调用方走网络）
 */
export async function hydrateTreeFromDisk(owner: string, repo: string, sha: string): Promise<CachedTree | undefined> {
  const key = treeCacheKey(owner, repo, sha);
  try {
    const raw = await fs.readFile(treeDiskFile(key), 'utf8');
    const parsed = JSON.parse(raw) as {
      ts: number;
      nodes: GitHubNode[];
      meta: { truncated?: boolean; exclusionReport?: any };
      // 兼容旧格式（直接存 tree 数组——附加属性已丢失，仅节点可恢复）
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

/** 命中返回深拷贝；未命中/过期返回 undefined */
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
