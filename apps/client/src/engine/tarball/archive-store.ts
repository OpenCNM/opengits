// 职责：本地归档存取与归档目录管理（repo-tarball 拆分模块之一）。
// - 路径安全校验与归档目录定位（archiveDirFor，供兄弟模块共享）
// - tarball 下载/解压/原子替换（ensureArchive 单飞 + 超时负缓存）
// - 归档内文件读取/复制（readFileLocal / copyFileLocal）与本地优先内容解析
// - 归档增量 diff（diffArchives）
// - 归档目录管理：孤儿 tmp 清理 + GC（TTL 清扫 + 双水位评分驱逐）
//
// 设计要点：
// - 纯下载去重缓存：同一 (repo, sha) 只从 GitHub 下载一次，物理布局 storage/repos/{owner}/{repo}/{sha}/
// - 用户课程快照（Document.content + ImportRecord.sha）与归档完全解耦，
//   GC（TTL 清扫 + 双水位评分驱逐）可随时安全回收任意条目
// - 单飞：同 sha 并发 ensure 共享同一个下载 Promise，杜绝重复下载
// - 原子替换：先解压到 tmp 再 rename，读者永远看不到半成品
// - 按 sha 分目录（常态 1 份，换版过渡期最多 2 份并存），旧 sha 回退走"按 sha 的 raw 拉取"，永不混入新内容
//
// 安全：
// - owner/repo/sha 全部经字符白名单校验后才拼接路径（防路径穿越）
// - tar 解压按条目过滤绝对路径与 `..` 穿越
// - 解压后体积超过 entryCapBytes 的仓库不落盘，调用方回退原有网络路径

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

// ---------- 路径安全 ----------

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

export async function hasLocalArchive(owner: string, repo: string, sha: string): Promise<boolean> {
  if (!sha) return false;
  try {
    const dir = archiveDirFor(owner, repo, sha);
    return await fs.pathExists(dir);
  } catch {
    // 容错降级: 归档探测失败视为无本地缓存（fail-open 缓存语义，调用方走网络拉取）
    return false;
  }
}

/**
 * 寻找本地归档中指定仓库最新缓存的 40 位 Git SHA（按 mtime 倒序）。
 * 用于网络不可达或 GitHub API 限流时无缝复用已有物理归档。
 */
export async function findLatestLocalArchiveSha(owner: string, repo: string): Promise<string | null> {
  const repoDir = path.join(TARBALL_CACHE.dir, owner.toLowerCase(), repo.toLowerCase());
  try {
    const entries = await fs.readdir(repoDir, { withFileTypes: true });
    const shaEntries = entries.filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/i.test(e.name));
    if (shaEntries.length === 0) return null;
    if (shaEntries.length === 1) return shaEntries[0].name.toLowerCase();

    const withStats = await Promise.all(
      shaEntries.map(async (e) => {
        // 容错降级: 目录在列举与 stat 之间被 GC 时 mtime 记 0（排序兜底）
        const stat = await fs.stat(path.join(repoDir, e.name)).catch(() => null);
        return { name: e.name.toLowerCase(), mtimeMs: stat?.mtimeMs || 0 };
      })
    );
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats[0].name;
  } catch {
    // 容错降级: 归档目录列举失败视为无本地缓存（网络限流回退路径自然降级到在线拉取）
    return null;
  }
}

// ---------- 元数据（hits / lastHitAt 供 GC 统计驱逐） ----------

// ArchiveMeta / MetaStore 由 './tarball-meta' 提供（见上方 import）

// ---------- 缓存键 ----------

function archiveKey(owner: string, repo: string, sha: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}@${sha.toLowerCase()}`;
}

/**
 * 从归档复制文件到目标目录（图片等二进制资产的本地化回退）。
 * 归档不存在或文件缺失返回 false（调用方回退 raw 网络拉取）。
 * 复制成功后累计 hits。
 */
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

  // 防路径穿越：源必须在归档目录内，目标必须落在 destDir 内
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

/**
 * 启动清扫：删除归档目录下遗留的 `.tmp-*` 孤儿目录
 * （进程在"下载→rename"之间崩溃留下的半成品；GC 只认 metadata 注册条目，管不到它们）。
 * 惰性执行：也可显式调用。
 */
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
      // 容错降级: 无权限/消失的目录直接跳过（启动清扫是尽力语义）
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.includes('.tmp-') || entry.name.endsWith('.tmp')) {
          // 容错降级: 孤儿 tmp 目录尽力清理（清理失败不影响启动）
          await fs.remove(full).catch(() => undefined);
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

/**
 * 启动清扫（小写归一）：archiveDirFor/archiveKey 已统一小写口径，历史混合大小写
 * 落盘目录永远无法被命中。原地重命名为小写（目标不存在时）；目标已存在则回收混合
 * 大小写副本；metadata 键同步归一到 archiveKey 口径。与 Go 侧
 * EnsureService.normalizeLegacyCaseDirs 同语义（共享卷部署时任一侧先启动即完成归一，
 * 另一侧空转；幂等）。
 */
export async function normalizeLegacyCaseDirs(): Promise<{ renamed: number; removed: number }> {
  const rootDir = path.resolve(TARBALL_CACHE.dir);
  if (!(await fs.pathExists(rootDir))) return { renamed: 0, removed: 0 };
  let renamed = 0;
  let removed = 0;

  let owners: import('fs').Dirent[] = [];
  try {
    owners = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    // 容错降级: 归一清扫失败空转（幂等，下次启动自动重试）
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
      // 容错降级: 无权限/消失的仓库目录跳过（归一清扫尽力语义）
      continue;
    }
    for (const repoEntry of repos) {
      if (!repoEntry.isDirectory()) continue;
      const src = path.join(ownerDir, repoEntry.name);
      const dst = path.join(rootDir, lowerOwner, repoEntry.name.toLowerCase());
      if (src === dst) continue;
      // 容错降级: stat 失败（目录被并发 GC）分别视为"源已消失跳过"与"目标不存在"
      const srcStat = await fs.stat(src).catch(() => null);
      if (!srcStat) continue;
      const dstStat = await fs.stat(dst).catch(() => null);
      if (dstStat) {
        if (srcStat.ino === dstStat.ino && srcStat.dev === dstStat.dev) {
          // 大小写不敏感 FS（macOS/共享卷）：dst 与 src 同一物理目录——小写路径
          // 天然可命中，重命名/删除都属破坏性误操作
          continue;
        }
        // 容错降级: 混合大小写副本尽力回收
        await fs.remove(src).catch(() => undefined);
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
      // 容错降级: 空属主目录尽力回收（列举失败视为非空不删，误删风险为零）
      const leftover = await fs.readdir(ownerDir).catch(() => null);
      if (leftover !== null && leftover.length === 0) {
        await fs.remove(ownerDir).catch(() => undefined);
      }
    }
  }

  // metadata 键归一（archiveKey 小写口径）；归一键已存在时弃用旧键
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

/**
 * 确保归档存在。下载/解压完全由 Go worker-sidecar 承接（Fail-Closed：sidecar 故障显式抛错，零本地 Node OOM 风险）。
 * - 返回 { dir, fromCache }；dir 为 null 表示超限跳过缓存（合法业务结果，调用方走网络路径产品行为）
 * - 本地路径按 TARBALL_CACHE.dir 重算，不透传 sidecar 容器内部路径
 */
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
  // Fail-Closed（2026-09-11 收刀）：sidecar 故障显式抛错（调用方不再静默回落网络
  // 路径）；dir=null（超限跳过）是合法业务结果，网络路径属产品行为
  const viaSidecar = await ensureArchiveViaSidecar(owner, repo, sha, {
    token,
    signal,
    sizeHintBytes,
  });
  return viaSidecar.dir === null
    ? { dir: null, fromCache: false }
    : { dir: archiveDirFor(owner, repo, sha), fromCache: viaSidecar.fromCache };
}

/**
 * 归档增量 diff：对比新旧两个归档的变更分类。
 * - Go 原生高速哈希对比（Go worker-sidecar 单实现，Fail-Closed：故障显式抛 SidecarError）
 * - 404 / 归档缺失返回 null
 */
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

/**
 * 本地读取归档内文件。未缓存返回 null；读取失败抛错由调用方回退。
 * @param maxBytes 仅读取文件头部前 maxBytes 字节（标题精提场景避免整读大文件）。
 */
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

  // 防路径穿越：目标必须落在归档目录内
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

/**
 * 本地优先的内容解析：归档命中 → 磁盘读；未命中 → 按 ref（branch 或 sha）走 raw 网络回退。
 * 与 Fetcher.getRawContent 行为对齐：非 markdown 文件包一层 wrapCodeAsMdx。
 */
export async function getFileContentLocalFirst(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  options?: { signal?: AbortSignal; token?: string }
): Promise<string> {
  // 取消检查前置：超时后不再发起归档读/网络回源
  options?.signal?.throwIfAborted?.();
  // 只有 sha 形态的 ref 才能命中归档（branch 名可能是任意字符串，无法直接定位）
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

  // 网络回退带用户身份（无 token 才落平台池/匿名——githubFetch 咽喉语义）
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

/** 手动全清（脚本用）：清空归档目录与元数据。 */
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
