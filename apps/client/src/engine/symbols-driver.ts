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

// Commit-scoped grounding is immutable for a given sha; FIFO cap bounds long-lived worker memory while skipping errors.
const conceptGroundingCache = new Map<string, ConceptGroundingResult>();
const CONCEPT_GROUNDING_CACHE_MAX = 2000;

function conceptGroundingCacheKey(p: SidecarConceptGroundingParams): string {
  const sortedScope = p.scopeFiles && p.scopeFiles.length > 0 ? Array.from(new Set(p.scopeFiles)).sort().join(',') : '';
  return `${p.owner}/${p.repo}@${p.sha}::${p.conceptName}::${sortedScope}`;
}

export function clearConceptGroundingCacheForTest(): void {
  conceptGroundingCache.clear();
}

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
