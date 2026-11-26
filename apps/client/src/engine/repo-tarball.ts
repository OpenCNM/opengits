import 'dotenv/config';

export {
  assertSafeSegments,
  archiveDirFor,
  SCOPED_UNPACK_MARKER,
  isScopedLocalArchive,
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

export type { ArchiveMeta, MetaStore } from './tarball/tarball-meta';

export {
  resolveLatestSha,
  fetchCompareDiff,
  fetchRawFileHead,
} from './tarball/github-api';
export type {
  GitHubCompareFile,
  GitHubCompareResponse,
} from './tarball/github-api';

export { treeFromArchive } from './tarball/tree-parse';

import { resolveLatestSha } from './tarball/github-api';
import { findLatestLocalArchiveSha } from './tarball/archive-store';

const FULL_GIT_SHA_RE = /^[0-9a-fA-F]{40}$/;

// Falls back to the latest cached local SHA when GitHub API is unreachable or rate-limited.
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
