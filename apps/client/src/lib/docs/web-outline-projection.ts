import { ENGINE_CONFIG } from '@/lib/config';
import type { NavNode } from '@/engine/structurizer';
import type { OutlineView } from '@/lib/outline-reader';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';

/**
 * ─────────────────────────────────────────────────────────────
 * Web SSR/RSC 端专职 L1 纯内存大纲与导航投影层
 * (Web L1 In-Memory Fast-Path)
 *
 * 职责与原理：
 * 1. 在 Node.js 进程内存中保留已解析的大纲、NavNode 树、文档路径列表与轻量仓库快照；
 * 2. 一致性靠「写路径显式失效（invalidateWebL1Projection）+ TTL 兜底」双保险，
 *    不做读侧指纹复验（复验需每请求查库，与 0 查库快路径的物理目标冲突）；
 * 3. 并发单飞防击穿（Singleflight Concurrency Deduplication）：海量并发打冷仓只向 DB 发起 1 次查询；
 * 4. 彻底消除 Web 阅读页面重复查库与树递归遍历（首屏 TTFB 降至 <15ms，布局层 <5ms）；
 * 5. 严格遵循多租户与只读隔离原则：绝不缓存任何用户专属的动态数据（阅读进度、点赞态等实时求值）。
 * ─────────────────────────────────────────────────────────────
 */

export interface WebL1OutlineProjection {
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  edition: string;
  gitSha: string | null;
  outlineVersion: number;
  outline: OutlineView;
  navTree: NavNode[];
  docPaths: string[];
  teachingDocPaths: string[];
  editionOptions: RepositoryEditionOption[];
  repoSnapshot: {
    id: string;
    owner: string;
    repo: string;
    branch: string;
    edition: string;
    isPublic: boolean;
    relayEnabled?: boolean;
    repoProfile: unknown;
    transcriptionModels: string[];
    transcriptionTokens: number;
    helpfulCount: number;
    navTree: unknown;
  };
  builtAt: number;
  expiresAt: number;
}

export const DEFAULT_L1_TTL_MS = (ENGINE_CONFIG?.docsRead?.outlineCacheTtlSeconds ?? 60) * 1000;
const MAX_PROJECTIONS_CAPACITY = 512;

// 进程内投影 Map（key: owner/repo:edition -> WebL1OutlineProjection）
const projections = new Map<string, WebL1OutlineProjection>();

// repoId -> Set<key> 双向反向索引（支持按 repositoryId O(1) 失效）
const repoIdToKeys = new Map<string, Set<string>>();

function removeRepoIdKey(repositoryId: string | undefined, key: string): void {
  if (!repositoryId) return;
  const keySet = repoIdToKeys.get(repositoryId);
  if (!keySet) return;
  keySet.delete(key);
  if (keySet.size === 0) {
    repoIdToKeys.delete(repositoryId);
  }
}

// In-Flight 并发单飞 Map（key: owner/repo:edition -> Promise）
const inFlight = new Map<string, Promise<WebL1OutlineProjection | null>>();

/**
 * 构造统一规范化的缓存 Key
 */
function normalizeProjectionKey(owner: string, repo: string, edition?: string): string {
  const normOwner = (owner || '').trim().toLowerCase();
  const normRepo = (repo || '').trim().toLowerCase();
  const normEdition = (edition || '').trim().toLowerCase();
  return `${normOwner}/${normRepo}:${normEdition}`;
}

/**
 * 将投影写入进程内 L1 缓存（维护 LRU 淘汰与双向索引）
 */
export function setWebL1OutlineProjection(projection: WebL1OutlineProjection): void {
  if (!projection || !projection.owner || !projection.repo || !projection.repositoryId) {
    return;
  }

  const key = normalizeProjectionKey(projection.owner, projection.repo, projection.edition);

  // 1. 若超容量上限，按插入顺序 LRU 淘汰最老条目
  if (projections.size >= MAX_PROJECTIONS_CAPACITY && !projections.has(key)) {
    const oldestKey = projections.keys().next().value;
    if (oldestKey) {
      const oldProj = projections.get(oldestKey);
      projections.delete(oldestKey);
      removeRepoIdKey(oldProj?.repositoryId, oldestKey);
    }
  }

  // 1.5 若该 key 已存在且关联不同的 repositoryId，清理旧 repositoryId 的反向索引
  const existingProj = projections.get(key);
  if (existingProj && existingProj.repositoryId !== projection.repositoryId) {
    removeRepoIdKey(existingProj.repositoryId, key);
  }

  // 2. 刷新 LRU 序位（Map 重新 set 会移至末尾）
  projections.delete(key);
  projections.set(key, projection);

  // 3. 维护 repoId 反向映射
  let keySet = repoIdToKeys.get(projection.repositoryId);
  if (!keySet) {
    keySet = new Set<string>();
    repoIdToKeys.set(projection.repositoryId, keySet);
  }
  keySet.add(key);
}

/**
 * 获取 L1 内存投影（支持可选 Singleflight 加载器）
 * @param owner 组织/所有者
 * @param repo 仓库名
 * @param edition 讲法（可选）
 * @param loader 若未命中时的异步加载函数（多并发下仅执行一次）
 */
export async function getWebL1OutlineProjection(
  owner: string,
  repo: string,
  edition?: string,
  loader?: () => Promise<WebL1OutlineProjection | null>
): Promise<WebL1OutlineProjection | null> {
  const key = normalizeProjectionKey(owner, repo, edition);
  const now = Date.now();

  // 1. 检查当前内存缓存
  const cached = projections.get(key);
  if (cached) {
    if (cached.expiresAt > now) {
      // 命中且未过期：刷新 LRU 序位并极速返回
      projections.delete(key);
      projections.set(key, cached);
      return cached;
    }
    // 已超租约：惰性清理
    invalidateWebL1Projection(key);
  }

  // 2. 检查是否有并发加载单飞中
  const existingFlight = inFlight.get(key);
  if (existingFlight) {
    return existingFlight;
  }

  // 3. 若无 loader，直接返回 null 引导外层处理
  if (!loader) {
    return null;
  }

  // 4. 发起 Singleflight 并发去重加载
  const flightPromise = (async () => {
    try {
      const result = await loader();
      if (result) {
        if (!result.expiresAt) {
          result.expiresAt = Date.now() + DEFAULT_L1_TTL_MS;
        }
        setWebL1OutlineProjection(result);
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, flightPromise);
  return flightPromise;
}

/**
 * 根据 repositoryId 尝试获取已有的 L1 内存投影（只读纯内存，0ms）
 */
export async function getWebL1OutlineProjectionById(
  repositoryId: string
): Promise<WebL1OutlineProjection | null> {
  if (!repositoryId) return null;

  const keySet = repoIdToKeys.get(repositoryId);
  if (!keySet || keySet.size === 0) return null;

  const now = Date.now();
  for (const key of keySet) {
    const cached = projections.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        return cached;
      }
      // 过期清理
      invalidateWebL1Projection(key);
    }
  }

  return null;
}

/**
 * 精确失效 L1 内存投影（支持 repositoryId、owner/repo:edition、或 owner/repo 前缀）
 */
export function invalidateWebL1Projection(repositoryIdOrKey: string): void {
  if (!repositoryIdOrKey) return;

  const target = repositoryIdOrKey.trim();

  // 1. 按 repositoryId 失效
  if (repoIdToKeys.has(target)) {
    const keys = repoIdToKeys.get(target);
    if (keys) {
      for (const k of keys) {
        projections.delete(k);
        inFlight.delete(k);
      }
    }
    repoIdToKeys.delete(target);
    return;
  }

  // 2. 按具体 key（如 owner/repo:edition）失效
  const normKey = target.toLowerCase();
  if (projections.has(normKey)) {
    const proj = projections.get(normKey);
    projections.delete(normKey);
    inFlight.delete(normKey);
    removeRepoIdKey(proj?.repositoryId, normKey);
    return;
  }

  // 3. 按 owner/repo 前缀失效（例如 owner/repo 匹配该仓的所有 edition）
  if (normKey.includes('/')) {
    const prefix = normKey.endsWith(':') ? normKey : `${normKey}:`;
    const toDelete: string[] = [];
    for (const k of projections.keys()) {
      if (k.startsWith(prefix) || k === normKey) {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) {
      const proj = projections.get(k);
      projections.delete(k);
      inFlight.delete(k);
      removeRepoIdKey(proj?.repositoryId, k);
    }
  }
}

/**
 * 仅用于单测：清理所有 L1 内存投影与单飞状态
 */
export function clearWebL1ProjectionsForTest(): void {
  projections.clear();
  repoIdToKeys.clear();
  inFlight.clear();
}

/**
 * 仅用于单测：获取当前内存投影数量
 */
export function getWebL1ProjectionsCountForTest(): number {
  return projections.size;
}
