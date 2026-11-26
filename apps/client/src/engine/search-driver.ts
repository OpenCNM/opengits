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
