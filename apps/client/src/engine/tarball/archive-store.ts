import fs from 'fs-extra';
import path from 'path';
import { TARBALL_CACHE } from '../../lib/config';
import { MODULE_ROLE_PATTERNS } from '../language-map';
import { wrapCodeAsMdx } from '../code-to-mdx';
import { Fetcher } from '../fetcher';
import {
  ArchiveMeta,
  MetaStore,
  loadMeta,
  setMetaCache,
  markMetaDirty,
  flushMeta,
  cancelPendingMetaSave,
} from './tarball-meta';
import {
  ensureArchiveViaSidecar,
} from './archive-sidecar-driver';
import { executeArchiveDiff } from '../diff-driver';
import { ignoreBestEffort } from '@/lib/best-effort';

const PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function assertSafeSegments(owner: string, repo: string, sha: string): void {
  if (!PATH_SEGMENT_RE.test(owner) || !PATH_SEGMENT_RE.test(repo)) {
    throw new Error(`[RepoTarball] Invalid owner/repo segment: ${owner}/${repo}`);
  }
  if (!SHA_RE.test(sha)) {
    throw new Error(`[RepoTarball] Invalid sha segment: ${sha}`);
  }
}

export function archiveDirFor(owner: string, repo: string, sha: string): string {
  assertSafeSegments(owner, repo, sha);
  return path.join(TARBALL_CACHE.dir, owner.toLowerCase(), repo.toLowerCase(), sha.toLowerCase());
}

export const SCOPED_UNPACK_MARKER = '.scoped_unpack';

// Treat marker probe errors as scoped (fail-closed) so partial unpacks never pose as full archives.
export async function isScopedLocalArchive(dir: string): Promise<boolean> {
  if (!dir) return false;
  try {
    return await fs.pathExists(path.join(dir, SCOPED_UNPACK_MARKER));
  } catch (err) {
    console.warn('[RepoTarball] Scoped archive marker probe failed:', err);
    return true;
  }
}

export async function hasLocalArchive(owner: string, repo: string, sha: string): Promise<boolean> {
  if (!sha) return false;
  try {
    const dir = archiveDirFor(owner, repo, sha);
    if (!(await fs.pathExists(dir))) return false;
    return !(await isScopedLocalArchive(dir));
  } catch (err) {
    ignoreBestEffort(err);
    return false;
  }
}

export async function findLatestLocalArchiveSha(owner: string, repo: string): Promise<string | null> {
  const repoDir = path.join(TARBALL_CACHE.dir, owner.toLowerCase(), repo.toLowerCase());
  try {
    const entries = await fs.readdir(repoDir, { withFileTypes: true });
    const shaEntries = entries.filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/i.test(e.name));
    if (shaEntries.length === 0) return null;
    if (shaEntries.length === 1) return shaEntries[0].name.toLowerCase();

    const withStats = await Promise.all(
      shaEntries.map(async (e) => {
        const stat = await fs.stat(path.join(repoDir, e.name)).catch(() => null);
        return { name: e.name.toLowerCase(), mtimeMs: stat?.mtimeMs || 0 };
      })
    );
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats[0].name;
  } catch {
    return null;
  }
}

function archiveKey(owner: string, repo: string, sha: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}@${sha.toLowerCase()}`;
}

export async function copyFileLocal(
  owner: string,
  repo: string,
  sha: string,
  filePath: string,
  destDir: string
): Promise<boolean> {
  const key = archiveKey(owner, repo, sha);
  const finalDir = archiveDirFor(owner, repo, sha);
  if (!(await fs.pathExists(finalDir))) return false;

  // Enforce strict root containment to block path traversal outside archive/dest directories.
  const src = path.resolve(finalDir, filePath);
  if (!src.startsWith(path.resolve(finalDir) + path.sep)) {
    throw new Error(`[RepoTarball] Path traversal blocked: ${filePath}`);
  }
  const dest = path.resolve(destDir, filePath);
  if (!dest.startsWith(path.resolve(destDir) + path.sep)) {
    throw new Error(`[RepoTarball] Path traversal blocked (dest): ${filePath}`);
  }

  if (!(await fs.pathExists(src)) || (await fs.stat(src)).isDirectory()) return false;

  await fs.ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);

  const meta = await loadMeta();
  const entry = meta[key];
  if (entry) {
    entry.hits += 1;
    entry.lastHitAt = Date.now();
    markMetaDirty();
  }
  return true;
}

export async function cleanupOrphanTmpDirs(): Promise<{ removed: number }> {
  const rootDir = path.resolve(TARBALL_CACHE.dir);
  if (!(await fs.pathExists(rootDir))) return { removed: 0 };
  let removed = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.includes('.tmp-') || entry.name.endsWith('.tmp')) {
          await fs.remove(full).catch(ignoreBestEffort);
          removed++;
        } else {
          stack.push(full);
        }
      }
    }
  }
  if (removed > 0) {
    console.warn(`[RepoTarball] Startup cleanup removed ${removed} orphan tmp dir(s)`);
  }
  return { removed };
}

export async function normalizeLegacyCaseDirs(): Promise<{ renamed: number; removed: number }> {
  const rootDir = path.resolve(TARBALL_CACHE.dir);
  if (!(await fs.pathExists(rootDir))) return { renamed: 0, removed: 0 };
  let renamed = 0;
  let removed = 0;

  let owners: import('fs').Dirent[] = [];
  try {
    owners = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return { renamed: 0, removed: 0 };
  }
  for (const ownerEntry of owners) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerDir = path.join(rootDir, ownerEntry.name);
    const lowerOwner = ownerEntry.name.toLowerCase();
    let repos: import('fs').Dirent[] = [];
    try {
      repos = await fs.readdir(ownerDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const repoEntry of repos) {
      if (!repoEntry.isDirectory()) continue;
      const src = path.join(ownerDir, repoEntry.name);
      const dst = path.join(rootDir, lowerOwner, repoEntry.name.toLowerCase());
      if (src === dst) continue;
      const srcStat = await fs.stat(src).catch(() => null);
      if (!srcStat) continue;
      const dstStat = await fs.stat(dst).catch(() => null);
      if (dstStat) {
        if (srcStat.ino === dstStat.ino && srcStat.dev === dstStat.dev) {
          // On case-insensitive filesystems (e.g. macOS), src and dst refer to the same inode; deleting src would destroy dst.
          continue;
        }
        await fs.remove(src).catch(ignoreBestEffort);
        removed++;
      } else {
        await fs.ensureDir(path.dirname(dst));
        const ok = await fs.rename(src, dst).then(
          () => true,
          () => false
        );
        if (ok) renamed++;
      }
    }
    if (ownerEntry.name !== lowerOwner) {
      const leftover = await fs.readdir(ownerDir).catch(() => null);
      if (leftover !== null && leftover.length === 0) {
        await fs.remove(ownerDir).catch(ignoreBestEffort);
      }
    }
  }

  const meta = await loadMeta();
  let metaChanged = false;
  for (const key of Object.keys(meta)) {
    const entry = meta[key];
    const normalized = `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}@${entry.sha.toLowerCase()}`;
    if (normalized === key) continue;
    if (!(normalized in meta)) meta[normalized] = entry;
    delete meta[key];
    metaChanged = true;
  }
  if (metaChanged) {
    markMetaDirty();
    await flushMeta();
  }

  if (renamed > 0 || removed > 0) {
    console.warn(`[RepoTarball] Case normalization: renamed ${renamed}, removed ${removed} legacy archive dir(s)`);
  }
  return { renamed, removed };
}

// dir=null indicates intentional size-cap skip (callers fall back to network fetch), distinct from sidecar errors.
export async function ensureArchive(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
  signal?: AbortSignal,
  sizeHintBytes?: number
): Promise<{ dir: string | null; fromCache: boolean }> {
  if (typeof sizeHintBytes === 'number' && sizeHintBytes > TARBALL_CACHE.entryCapBytes) {
    return { dir: null, fromCache: false };
  }
  const viaSidecar = await ensureArchiveViaSidecar(owner, repo, sha, {
    token,
    signal,
    sizeHintBytes,
  });
  // Recompute dir from local TARBALL_CACHE.dir because sidecar returns container-local paths.
  return viaSidecar.dir === null
    ? { dir: null, fromCache: false }
    : { dir: archiveDirFor(owner, repo, sha), fromCache: viaSidecar.fromCache };
}

export interface ArchiveDiff {
  added: Set<string>;
  modified: Set<string>;
  removed: Set<string>;
  renamed: Array<{ from: string; to: string }>;
}

export async function diffArchives(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string
): Promise<ArchiveDiff | null> {
  assertSafeSegments(owner, repo, oldSha);
  assertSafeSegments(owner, repo, newSha);
  return await executeArchiveDiff(owner, repo, oldSha, newSha);
}

export async function readFileLocal(
  owner: string,
  repo: string,
  sha: string,
  filePath: string,
  maxBytes?: number
): Promise<string | null> {
  const key = archiveKey(owner, repo, sha);
  const finalDir = archiveDirFor(owner, repo, sha);
  if (!(await fs.pathExists(finalDir))) return null;

  const full = path.resolve(finalDir, filePath);
  if (!full.startsWith(path.resolve(finalDir) + path.sep)) {
    throw new Error(`[RepoTarball] Path traversal blocked: ${filePath}`);
  }

  if (!(await fs.pathExists(full)) || (await fs.stat(full)).isDirectory()) return null;

  let content: string;
  if (maxBytes && maxBytes > 0) {
    const fh = await fs.promises.open(full, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      content = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } else {
    content = await fs.readFile(full, 'utf8');
  }

  const meta = await loadMeta();
  const entry = meta[key];
  if (entry) {
    entry.hits += 1;
    entry.lastHitAt = Date.now();
    markMetaDirty();
  }
  return content;
}

export async function getFileContentLocalFirst(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  options?: { signal?: AbortSignal; token?: string }
): Promise<string> {
  options?.signal?.throwIfAborted?.();
  // Only SHA refs map deterministically to cached archive directories; branch refs fall back to raw fetch.
  const sha = SHA_RE.test(ref) ? ref : null;
  if (sha) {
    try {
      const local = await readFileLocal(owner, repo, sha, filePath);
      if (local !== null) {
        return MODULE_ROLE_PATTERNS.markdownExtensions.some((ext) => filePath.endsWith(ext))
          ? local
          : wrapCodeAsMdx(filePath, local);
      }
    } catch (err) {
      console.warn(`[RepoTarball] Local read failed for ${owner}/${repo}@${sha}/${filePath}, falling back to raw`, err);
    }
  }

  const fetcher = new Fetcher(owner, repo, ref, options?.token, { signal: options?.signal });
  return fetcher.getRawContent(filePath);
}

async function deleteEntry(meta: MetaStore, key: string): Promise<void> {
  const entry = meta[key];
  if (!entry) return;
  try {
    await fs.remove(archiveDirFor(entry.owner, entry.repo, entry.sha));
  } catch (err) {
    console.warn(`[RepoTarball] Failed to remove ${key}:`, err);
  }
  delete meta[key];
}

export async function purgeRepoCache(): Promise<{ removed: number }> {
  cancelPendingMetaSave();
  const meta = await loadMeta();
  const keys = Object.keys(meta);
  for (const key of keys) {
    await deleteEntry(meta, key);
  }
  setMetaCache({});
  await flushMeta(true);
  return { removed: keys.length };
}
