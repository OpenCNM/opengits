import type { Prisma } from '@prisma/client';
import { DocumentStatus } from '../lib/constants';
import { callSidecar } from '../lib/sidecar-client';

interface RegisterImportSnapshotParams {
  userId?: string | null;
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  sha: string | null;
  prefix?: string | null;
  /** null = shared canonical docs; userId = private snapshot isolated from other users. */
  docOwnerId: string | null;
  diff?: { changed: Set<string>; removed: Set<string> } | null;
  /** True when update-applier already applied targeted doc changes so snapshot advancement skips wiping chapters. */
  skipDocumentReset?: boolean;
}

export async function registerImportSnapshot(
  _tx: Prisma.TransactionClient,
  params: RegisterImportSnapshotParams
): Promise<{ shaChanged: boolean }> {
  const { userId, repositoryId, owner, repo, branch, sha, prefix, docOwnerId, diff, skipDocumentReset } = params;
  if (!userId || !sha) return { shaChanged: false };

  const res = await callSidecar<{ ok: boolean; shaChanged: boolean }>(
    '/v1/ingest/snapshot/register',
    {
      userId,
      repositoryId,
      owner,
      repo,
      branch,
      sha,
      prefix: prefix ?? null,
      docOwnerId: docOwnerId ?? null,
      changed: diff?.changed ? [...diff.changed] : [],
      removed: diff?.removed ? [...diff.removed] : [],
      skipDocumentReset: Boolean(skipDocumentReset),
    },
    { label: 'ingest-snapshot-register' }
  );

  return { shaChanged: Boolean(res?.shaChanged) };
}
