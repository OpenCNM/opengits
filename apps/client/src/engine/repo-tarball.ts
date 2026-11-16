// Tarball 组装入口（repo-tarball 拆分后的 re-export 门面）：
// 原导出符号在此全部 re-export，现有 import 路径（'@/engine/repo-tarball' / './repo-tarball'）零变化。
//
// 拆分后的职责模块：
// - ./tarball/archive-store  本地归档存取（ensureArchive/readFileLocal/copyFileLocal/diffArchives）+ 归档目录管理（孤儿清理 + GC）
// - ./tarball/github-api     GitHub 轻量 API 面（resolveLatestSha/fetchCompareDiff/fetchRawFileHead，带截断护栏）
// - ./tarball/tree-parse     tree 解析（treeFromArchive）
// 元数据层已单独抽离至 ./tarball/tarball-meta（保持原 re-export，勿在此重复实现）。

import 'dotenv/config';

// ---------- 本地归档存取 + 归档目录管理 ----------

export {
  assertSafeSegments,
  archiveDirFor,
  hasLocalArchive,
  findLatestLocalArchiveSha,
  copyFileLocal,
  cleanupOrphanTmpDirs,
  normalizeLegacyCaseDirs,
  ensureArchive,
  diffArchives,
  readFileLocal,
  getFileContentLocalFirst,
  purgeRepoCache,
} from './tarball/archive-store';
export type { ArchiveDiff } from './tarball/archive-store';

// ---------- 元数据类型（tarball-meta 原样透传） ----------

export type { ArchiveMeta, MetaStore } from './tarball/tarball-meta';

// ---------- GitHub 轻量 API 面 ----------

export {
  resolveLatestSha,
  fetchCompareDiff,
  fetchRawFileHead,
} from './tarball/github-api';
export type {
  GitHubCompareFile,
  GitHubCompareResponse,
} from './tarball/github-api';

// ---------- tree 解析 ----------

export { treeFromArchive } from './tarball/tree-parse';

import { resolveLatestSha } from './tarball/github-api';
import { findLatestLocalArchiveSha } from './tarball/archive-store';

const FULL_GIT_SHA_RE = /^[0-9a-fA-F]{40}$/;

/**
 * 将任意 Git Ref（40位哈希、短哈希、分支名 main/master、HEAD）解析为确定性的 40 位物理 Commit SHA。
 * 策略：
 * 1. 已经是 40 位 hex sha → 直接返回 (0ms)
 * 2. 尝试通过 GitHub 轻量 API 解析最新分支头 commit
 * 3. 若网络失败或限流，回退检索本地磁盘已有归档目录 (storage/repos)
 */
export async function resolveTargetSha(
  owner: string,
  repo: string,
  ref?: string | null,
  token?: string
): Promise<string> {
  const raw = (ref || '').trim();
  if (FULL_GIT_SHA_RE.test(raw)) {
    return raw.toLowerCase();
  }
  try {
    const resolved = await resolveLatestSha(owner, repo, raw || 'HEAD', token);
    if (FULL_GIT_SHA_RE.test(resolved)) {
      return resolved.toLowerCase();
    }
  } catch (err) {
    const cached = await findLatestLocalArchiveSha(owner, repo);
    if (cached) {
      return cached;
    }
    throw err;
  }
  const cached = await findLatestLocalArchiveSha(owner, repo);
  if (cached) {
    return cached;
  }
  throw new Error(`[RepoTarball] Unable to resolve valid 40-char Git SHA for ${owner}/${repo}@${raw || 'HEAD'}`);
}

