import { ENGINE_CONFIG } from '@/lib/config';
import type { NavNode } from '@/engine/structurizer';
import type { OutlineView } from '@/lib/outline-reader';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';

// In-memory L1 outline projection invalidated explicitly on writes + TTL; never caches per-user state.

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

const projections = new Map<string, WebL1OutlineProjection>();

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

const inFlight = new Map<string, Promise<WebL1OutlineProjection | null>>();

function normalizeProjectionKey(owner: string, repo: string, edition?: string): string {
  const normOwner = (owner || '').trim().toLowerCase();
  const normRepo = (repo || '').trim().toLowerCase();
  const normEdition = (edition || '').trim().toLowerCase();
  return `${normOwner}/${normRepo}:${normEdition}`;
}

export function setWebL1OutlineProjection(projection: WebL1OutlineProjection): void {
  if (!projection || !projection.owner || !projection.repo || !projection.repositoryId) {
    return;
  }

  const key = normalizeProjectionKey(projection.owner, projection.repo, projection.edition);

  if (projections.size >= MAX_PROJECTIONS_CAPACITY && !projections.has(key)) {
    const oldestKey = projections.keys().next().value;
    if (oldestKey) {
      const oldProj = projections.get(oldestKey);
      projections.delete(oldestKey);
      removeRepoIdKey(oldProj?.repositoryId, oldestKey);
    }
  }

  const existingProj = projections.get(key);
  if (existingProj && existingProj.repositoryId !== projection.repositoryId) {
    removeRepoIdKey(existingProj.repositoryId, key);
  }

  projections.delete(key);
  projections.set(key, projection);

  let keySet = repoIdToKeys.get(projection.repositoryId);
  if (!keySet) {
    keySet = new Set<string>();
    repoIdToKeys.set(projection.repositoryId, keySet);
  }
  keySet.add(key);
}

export async function getWebL1OutlineProjection(
  owner: string,
  repo: string,
  edition?: string,
  loader?: () => Promise<WebL1OutlineProjection | null>
): Promise<WebL1OutlineProjection | null> {
  const key = normalizeProjectionKey(owner, repo, edition);
  const now = Date.now();

  const cached = projections.get(key);
  if (cached) {
    if (cached.expiresAt > now) {
      projections.delete(key);
      projections.set(key, cached);
      return cached;
    }
    invalidateWebL1Projection(key);
  }

  const existingFlight = inFlight.get(key);
  if (existingFlight) {
    return existingFlight;
  }

  if (!loader) {
    return null;
  }

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
      invalidateWebL1Projection(key);
    }
  }

  return null;
}

export function invalidateWebL1Projection(repositoryIdOrKey: string): void {
  if (!repositoryIdOrKey) return;

  const target = repositoryIdOrKey.trim();

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

  const normKey = target.toLowerCase();
  if (projections.has(normKey)) {
    const proj = projections.get(normKey);
    projections.delete(normKey);
    inFlight.delete(normKey);
    removeRepoIdKey(proj?.repositoryId, normKey);
    return;
  }

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

export function clearWebL1ProjectionsForTest(): void {
  projections.clear();
  repoIdToKeys.clear();
  inFlight.clear();
}

export function getWebL1ProjectionsCountForTest(): number {
  return projections.size;
}
