import fs from 'fs-extra';
import path from 'path';
import { TARBALL_CACHE } from '../../lib/config';

export interface ArchiveMeta {
  owner: string;
  repo: string;
  sha: string;
  /** 解压后或压缩后总字节数 */
  size: number;
  /** 累计命中次数（ensure/readFileLocal 每命中 +1） */
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

/** Tarball 缓存聚合统计（admin 大盘消费的真实指标） */
interface TarballCacheStats {
  /** 缓存卷数（去重后的归档条目） */
  entryCount: number;
  /** 累计命中次数（即从本地缓存服务、未打 GitHub API 的次数） */
  totalHits: number;
  /** 缓存占用字节 */
  totalBytes: number;
}

/**
 * 直读文件聚合缓存统计——刻意绕过进程内 metaCache：
 * meta 的写入方是 web 进程，admin/worker 是独立进程，读自己进程的缓存会拿到陈旧快照。
 * 文件缺失/损坏返回全零（fail-soft），绝不编造数值。
 */
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

// ---------- 元数据持久化（debounce 落盘 + 串行写锁） ----------
// meta 只承载 GC 统计（hits/lastHitAt）与尺寸校验信息：崩溃最多丢一个 debounce 窗口，
// ensureArchive 会按需重建；dirty 守卫防止无变化时反复整文件落盘（写放大防护）。

const META_SAVE_DEBOUNCE_MS = 3000;

let metaDirty = false;
let metaSaveTimer: NodeJS.Timeout | null = null;
let metaWriteChain: Promise<void> = Promise.resolve();

function queueMetaWrite(meta: MetaStore): Promise<void> {
  const run = metaWriteChain.then(() => saveMeta(meta));
  metaWriteChain = run.catch(() => undefined);
  return run;
}

/** 标记元数据脏并调度延迟落盘（高频路径用，零阻塞） */
export function markMetaDirty(): void {
  metaDirty = true;
  if (metaSaveTimer) return;
  metaSaveTimer = setTimeout(() => {
    metaSaveTimer = null;
    void flushMeta().catch((err) => console.warn('[RepoTarball] Metadata flush failed:', err));
  }, META_SAVE_DEBOUNCE_MS);
}

/**
 * 落盘（默认仅在脏时执行；purge 等需强制清空持久化的场景传 force）。
 * 失败保留脏标记供下次重试。
 */
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

/** 取消待定的延迟落盘（purge 全清场景用） */
export function cancelPendingMetaSave(): void {
  if (metaSaveTimer) {
    clearTimeout(metaSaveTimer);
    metaSaveTimer = null;
  }
}
