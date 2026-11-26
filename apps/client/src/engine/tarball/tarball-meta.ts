import fs from 'fs-extra';
import path from 'path';
import { TARBALL_CACHE } from '../../lib/config';
import { ignoreBestEffort } from '@/lib/best-effort';

export interface ArchiveMeta {
  owner: string;
  repo: string;
  sha: string;
  size: number;
  hits: number;
  lastHitAt: number;
  createdAt: number;
  compacted?: boolean;
}

export type MetaStore = Record<string, ArchiveMeta>;

const metadataFile = () => path.join(TARBALL_CACHE.dir, 'metadata.json');

let metaCache: MetaStore | null = null;

export async function loadMeta(): Promise<MetaStore> {
  if (metaCache) return metaCache;
  try {
    const raw = await fs.readFile(metadataFile(), 'utf8');
    metaCache = JSON.parse(raw) as MetaStore;
  } catch {
    metaCache = {};
  }
  return metaCache;
}

async function saveMeta(meta: MetaStore): Promise<void> {
  await fs.ensureDir(TARBALL_CACHE.dir);
  const tmp = `${metadataFile()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fs.rename(tmp, metadataFile());
}

export function setMetaCache(meta: MetaStore | null): void {
  metaCache = meta;
}

interface TarballCacheStats {
  entryCount: number;
  totalHits: number;
  totalBytes: number;
}

// Reads disk directly to bypass the in-memory metaCache written by other processes.
export async function readTarballCacheStats(): Promise<TarballCacheStats> {
  let meta: MetaStore;
  try {
    const raw = await fs.readFile(metadataFile(), 'utf8');
    meta = JSON.parse(raw) as MetaStore;
  } catch {
    return { entryCount: 0, totalHits: 0, totalBytes: 0 };
  }
  let entryCount = 0;
  let totalHits = 0;
  let totalBytes = 0;
  for (const entry of Object.values(meta)) {
    entryCount += 1;
    totalHits += entry.hits;
    totalBytes += entry.size;
  }
  return { entryCount, totalHits, totalBytes };
}

const META_SAVE_DEBOUNCE_MS = 3000;

let metaDirty = false;
let metaSaveTimer: NodeJS.Timeout | null = null;
let metaWriteChain: Promise<void> = Promise.resolve();

// Serializes writes while absorbing errors on metaWriteChain so callers see failures without jamming future writes.
function queueMetaWrite(meta: MetaStore): Promise<void> {
  const run = metaWriteChain.then(() => saveMeta(meta));
  metaWriteChain = run.catch(ignoreBestEffort);
  return run;
}

export function markMetaDirty(): void {
  metaDirty = true;
  if (metaSaveTimer) return;
  metaSaveTimer = setTimeout(() => {
    metaSaveTimer = null;
    void flushMeta().catch((err) => console.warn('[RepoTarball] Metadata flush failed:', err));
  }, META_SAVE_DEBOUNCE_MS);
}

export async function flushMeta(force = false): Promise<void> {
  if (!force && !metaDirty) return;
  metaDirty = false;
  try {
    if (!metaCache) metaCache = await loadMeta();
    await queueMetaWrite(metaCache);
  } catch (err) {
    metaDirty = true;
    throw err;
  }
}

export function cancelPendingMetaSave(): void {
  if (metaSaveTimer) {
    clearTimeout(metaSaveTimer);
    metaSaveTimer = null;
  }
}
