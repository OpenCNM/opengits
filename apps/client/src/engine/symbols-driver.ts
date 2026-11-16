/**
 * apps/client/src/engine/symbols-driver.ts
 *
 * 符号服务驱动（Node/Next.js 端向 Go worker-sidecar 细粒度符号服务发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口，消灭 Node.js V8 堆内存开销
 *    与 WASM 线性内存碎片；
 * 2. Fail-Closed 单实现（2026-09-11 收刀）：本地实现已物理删除——sidecar
 *    故障显式抛 SidecarError（修复动作在 Go 端）。
 */

import { callSidecar } from '../lib/sidecar-client';

interface SymbolsExtractOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface SidecarConceptGroundingParams {
  owner: string;
  repo: string;
  sha: string;
  conceptName: string;
  scopeFiles?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ConceptGroundingRemoteResponse {
  ok: boolean;
  error?: string;
  backboneFiles: Array<{
    path: string;
    role: string;
    pageRank: number;
  }>;
  goldenSymbols: Array<{
    name: string;
    kind: string;
    file: string;
    score?: number;
  }>;
}

interface ConceptGroundingGoldenSymbol {
  name: string;
  kind: 'function' | 'type';
  file: string;
  score: number;
}

interface ConceptGroundingResult {
  backboneFiles: Array<{
    path: string;
    role: string;
    pageRank: number;
  }>;
  goldenSymbols: ConceptGroundingGoldenSymbol[];
}

/**
 * sha 键不可变缓存：(owner/repo, sha, concept, scope) → grounding 结果在同一
 * commit 上永久不变，进程级缓存命中即免一次读者热路径的 sidecar 往返
 * （docs 页渲染原为每请求现打 /v1/graph/concept-grounding，1.5s 超时预算
 * 直接挂在页面延迟上）。失败（throw）不缓存，成功即永久（进程重启自清）；
 * FIFO 容量上限防长驻进程无界增长。
 */
const conceptGroundingCache = new Map<string, ConceptGroundingResult>();
const CONCEPT_GROUNDING_CACHE_MAX = 2000;

function conceptGroundingCacheKey(p: SidecarConceptGroundingParams): string {
  const sortedScope = p.scopeFiles && p.scopeFiles.length > 0 ? Array.from(new Set(p.scopeFiles)).sort().join(',') : '';
  return `${p.owner}/${p.repo}@${p.sha}::${p.conceptName}::${sortedScope}`;
}

/** 测试钩子：清空 grounding 不可变缓存 */
export function clearConceptGroundingCacheForTest(): void {
  conceptGroundingCache.clear();
}

/**
 * 概念代码锚点查询驱动：优先向 Go worker-sidecar 原生接口发起调用，
 * 直接在 Go 端基于 storage/graphs 图谱产物就地执行筛选与关键词决胜，
 * 杜绝在 Node.js V8 堆中反序列化数十 MB 的大图谱 JSON。
 * 结果经 sha 键不可变缓存——同 commit 同概念只打一次 sidecar。
 */
export async function executeSidecarConceptGrounding(
  params: SidecarConceptGroundingParams,
  options?: SymbolsExtractOptions
): Promise<ConceptGroundingResult> {
  const cacheKey = conceptGroundingCacheKey(params);
  const cached = conceptGroundingCache.get(cacheKey);
  if (cached) return cached;

  const remote = await callSidecar<ConceptGroundingRemoteResponse>(
    '/v1/graph/concept-grounding',
    {
      owner: params.owner,
      repo: params.repo,
      sha: params.sha,
      conceptName: params.conceptName,
      scopeFiles: params.scopeFiles,
    },
    {
      label: 'graph /v1/graph/concept-grounding',
      timeoutMs: params.timeoutMs ?? options?.timeoutMs ?? 5000,
      signal: params.signal ?? options?.signal,
    }
  );

  if (!remote.ok) {
    throw new Error(`graph /v1/graph/concept-grounding: ${remote.error || 'malformed payload'}`);
  }

  const result: ConceptGroundingResult = {
    backboneFiles: remote.backboneFiles ?? [],
    goldenSymbols: (remote.goldenSymbols ?? []).map((s) => ({
      name: s.name,
      kind: s.kind === 'type' ? 'type' : 'function',
      file: s.file,
      score: typeof s.score === 'number' ? s.score : 0,
    })),
  };

  if (conceptGroundingCache.size >= CONCEPT_GROUNDING_CACHE_MAX) {
    const oldest = conceptGroundingCache.keys().next().value;
    if (oldest !== undefined) conceptGroundingCache.delete(oldest);
  }
  conceptGroundingCache.set(cacheKey, result);
  return result;
}

interface SidecarSymbolLookupParams {
  owner: string;
  repo: string;
  sha: string;
  name: string;
  file?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SymbolLookupDetail {
  name: string;
  kind: 'function' | 'type';
  file: string;
  startLine: number;
  endLine: number;
  role: 'core_contract' | 'entry_point' | 'pipeline_flow' | 'leaf_utility';
  pageRank: number;
  importers: number;
  callers: string[];
}

export interface SymbolLookupResult {
  ok: boolean;
  found: boolean;
  symbol?: SymbolLookupDetail | null;
  error?: string;
}

/**
 * 细粒度代码符号检索驱动：优先向 Go worker-sidecar 原生接口发起调用，
 * 直接在 Go 端基于 storage/graphs 图谱产物就地检索，
 * 封装 x-internal-token、3000ms 超时控制与 Fail-Open 优雅降级。
 */
export async function executeSidecarSymbolLookup(
  params: SidecarSymbolLookupParams,
  options?: SymbolsExtractOptions
): Promise<SymbolLookupResult> {
  if (!params.name || !params.owner || !params.repo || !params.sha) {
    return {
      ok: false,
      found: false,
      error: 'Missing required lookup parameters (owner, repo, sha, name)',
    };
  }

  try {
    const remote = await callSidecar<{
      ok: boolean;
      found: boolean;
      symbol?: SymbolLookupDetail;
      error?: string;
    }>(
      '/v1/graph/symbol-lookup',
      {
        owner: params.owner,
        repo: params.repo,
        sha: params.sha,
        name: params.name,
        file: params.file,
      },
      {
        label: 'graph /v1/graph/symbol-lookup',
        timeoutMs: params.timeoutMs ?? options?.timeoutMs ?? 3000,
        signal: params.signal ?? options?.signal,
      }
    );

    return {
      ok: remote.ok ?? true,
      found: remote.found ?? false,
      symbol: remote.symbol ?? null,
      error: remote.error,
    };
  } catch (err) {
    // Fail-Open 优雅降级：Sidecar 离线或超时不崩断前端文档阅读
    return {
      ok: false,
      found: false,
      symbol: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface SidecarSymbolSearchParams {
  owner: string;
  repo: string;
  sha: string;
  query?: string;
  file?: string;
  roleFilter?: string;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface SymbolSearchResult {
  ok: boolean;
  symbols: SymbolLookupDetail[];
  error?: string;
}

/**
 * 细粒度代码符号拓扑与模糊检索驱动：向 Go worker-sidecar /v1/graph/symbol-search 发起调用，
 * 直接基于 storage/graphs 图谱就地执行 PageRank 拓扑加权排序，支持 Fail-Open 降级。
 */
export async function executeSidecarSymbolSearch(
  params: SidecarSymbolSearchParams,
  options?: SymbolsExtractOptions
): Promise<SymbolSearchResult> {
  if (!params.owner || !params.repo || !params.sha) {
    return {
      ok: false,
      symbols: [],
      error: 'Missing required search parameters (owner, repo, sha)',
    };
  }

  try {
    const remote = await callSidecar<{
      ok: boolean;
      symbols?: SymbolLookupDetail[];
      error?: string;
    }>(
      '/v1/graph/symbol-search',
      {
        owner: params.owner,
        repo: params.repo,
        sha: params.sha,
        query: params.query || '',
        file: params.file,
        roleFilter: params.roleFilter,
        limit: params.limit,
      },
      {
        label: 'graph /v1/graph/symbol-search',
        timeoutMs: params.timeoutMs ?? options?.timeoutMs ?? 3000,
        signal: params.signal ?? options?.signal,
      }
    );

    return {
      ok: remote.ok ?? true,
      symbols: remote.symbols ?? [],
      error: remote.error,
    };
  } catch (err) {
    return {
      ok: false,
      symbols: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

