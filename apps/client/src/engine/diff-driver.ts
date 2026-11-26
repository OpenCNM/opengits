import { callSidecar, SidecarError, type SidecarCallOptions } from '../lib/sidecar-client';
import { assertSafeSegments } from './tarball/archive-store';

export interface ArchiveDiff {
  added: Set<string>;
  modified: Set<string>;
  removed: Set<string>;
  renamed: Array<{ from: string; to: string }>;
}

interface RawArchiveDiff {
  added: string[];
  modified: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
}

export async function executeArchiveDiff(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string,
  options?: SidecarCallOptions
): Promise<ArchiveDiff | null> {
  assertSafeSegments(owner, repo, oldSha);
  assertSafeSegments(owner, repo, newSha);

  const payload = { owner, repo, oldSha, newSha };
  let res: RawArchiveDiff;
  try {
    res = await callSidecar<RawArchiveDiff>(
      '/v1/archive/diff',
      payload,
      { label: 'diff /v1/archive/diff', ...options }
    );
  } catch (err) {
    // 404 indicates an unmaterialized archive on disk (business null), distinct from sidecar failure.
    if (err instanceof SidecarError && err.status === 404) {
      return null;
    }
    throw err;
  }

  if (Array.isArray(res.added) && Array.isArray(res.modified) && Array.isArray(res.removed)) {
    return {
      added: new Set(res.added),
      modified: new Set(res.modified),
      removed: new Set(res.removed),
      renamed: Array.isArray(res.renamed) ? res.renamed : [],
    };
  }
  throw new Error('diff /v1/archive/diff: malformed archive diff payload');
}
