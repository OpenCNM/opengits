/**
 * apps/client/src/engine/search-driver.ts
 *
 * 高频检索与上下文摘要生成驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/search/chunks），在 Go 进程内直接完成
 *    PostgreSQL FTS/ILIKE 检索、Snippet 截取与 Title 解析，仅向 Node.js 返回轻量元数据，
 *    消解大文本在 V8 堆内存中的搬运与 GC 压力（Zero-Content Transport）；
 * 2. Fail-Closed 单实现（2026-09-11 收刀）：本地 Prisma + TS 降级路径已物理删除
 *    ——sidecar 故障显式抛 SidecarError（修复动作在 Go 端）；
 * 3. 严格遵循契约：输出结构与冻结契约一致（search-snippet 夹具锁定提取语义）。
 */

import { callSidecar } from '@/lib/sidecar-client';

interface SearchDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface SidecarSearchParams {
  repositoryId?: string;
  query: string;
  rawQuery?: string;
  limit?: number;
  userId?: string | null;
  locale?: string;
  version?: string;
  contentTypes?: string[];
  isGlobal?: boolean;
  snippetMaxLen?: number;
  includeContent?: boolean;
  tokenBudget?: number;
}

export interface SidecarSearchHit {
  chunkId: string;
  docId: string;
  title: string;
  path: string;
  heading?: string | null;
  headingPath?: string | null;
  snippet: string;
  similarity: number;
  owner?: string;
  repo?: string;
  content?: string;
  editionLabel?: string;
  matchCount?: number;
  ftsRank?: number;
}

interface SidecarSearchResponse {
  hits: SidecarSearchHit[];
}

/**
 * 通过 Go worker-sidecar 执行高性能在线分块检索与 Snippet 提取（Fail-Closed 单实现）。
 * 返回轻量结果数组；sidecar 故障显式抛 SidecarError。
 */
export async function executeSidecarSearch(
  params: SidecarSearchParams,
  options?: SearchDriverOptions
): Promise<SidecarSearchHit[]> {
  if (!params.query?.trim() && !params.rawQuery?.trim()) {
    return [];
  }

  const res = await callSidecar<SidecarSearchResponse>(
    '/v1/search/chunks',
    params,
    { label: 'search /v1/search/chunks', ...options }
  );

  if (!Array.isArray(res.hits)) {
    throw new Error('search /v1/search/chunks: malformed hits payload');
  }

  return res.hits;
}

interface SidecarIndexBuildResponse {
  ok: boolean;
  built: boolean;
}

/**
 * 委托 Go worker-sidecar 原生构建指定仓库的二进制搜索索引（/v1/search/index/build）。
 * 卸载 Node.js 进程全仓分词与压缩的 CPU 负载。
 */
export async function buildRepoBinaryIndexViaSidecar(
  repositoryId: string,
  options?: SearchDriverOptions
): Promise<{ built: boolean }> {
  if (!repositoryId?.trim()) {
    throw new Error('search /v1/search/index/build: repositoryId is required');
  }

  const res = await callSidecar<SidecarIndexBuildResponse>(
    '/v1/search/index/build',
    { repositoryId: repositoryId.trim() },
    { label: 'search /v1/search/index/build', ...options }
  );

  return { built: Boolean(res.built) };
}

export interface SidecarUnifiedSearchResultItem {
  id: string;
  type: 'repository_exists' | 'repository_import_cta' | 'document' | 'bundle' | 'featured_tutorial';
  isIngested?: boolean;
  title: string;
  description: string;
  url: string;
  owner?: string;
  repo?: string;
  category?: string;
  score: number;
}

interface SidecarUnifiedSearchParams {
  query: string;
  rawQuery?: string;
  owner?: string;
  repo?: string;
  userId?: string | null;
  exactOwner?: string;
  exactRepo?: string;
  limit?: number;
}

interface SidecarUnifiedSearchResponse {
  ok: boolean;
  hits: SidecarUnifiedSearchResultItem[];
}

/**
 * 统一混合检索（通过 Go worker-sidecar /v1/search/unified 执行，Fail-Closed 单实现）。
 * 覆盖 URL 探仓、单仓概念+分块聚合、全局仓库+合集包+跨仓分块检索与拓扑打分排序。
 */
export async function executeSidecarUnifiedSearch(
  params: SidecarUnifiedSearchParams,
  options?: SearchDriverOptions
): Promise<SidecarUnifiedSearchResultItem[]> {
  if (!params.query?.trim() && !params.rawQuery?.trim()) {
    return [];
  }

  const res = await callSidecar<SidecarUnifiedSearchResponse>(
    '/v1/search/unified',
    params,
    { label: 'search /v1/search/unified', ...options }
  );

  if (!res?.ok || !Array.isArray(res.hits)) {
    throw new Error('search /v1/search/unified: malformed hits payload');
  }

  return res.hits;
}



