import { callSidecar } from '../lib/sidecar-client';
import type { WebDocDiffResult } from './web-doc/types';
import type { PreviousSyncState } from './web-doc/diff-detector';

const DEFAULT_TIMEOUT_MS = 10_000;

interface WebDocDiffCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function executeSidecarWebDocDiff(
  rootUrl: string,
  previousState?: PreviousSyncState,
  options: WebDocDiffCallOptions = {}
): Promise<WebDocDiffResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  const payload = {
    rootUrl,
    prevEtag: previousState?.etag,
    prevLastMod: previousState?.sitemapLastMod,
    timeoutMs,
  };

  const remote = await callSidecar<WebDocDiffResult>(
    '/v1/web-doc/diff',
    payload,
    {
      label: 'web-doc /v1/web-doc/diff',
      timeoutMs,
      signal,
    }
  );

  if (typeof remote.hasChanges !== 'boolean') {
    throw new Error('web-doc /v1/web-doc/diff: malformed diff payload');
  }
  return {
    hasChanges: remote.hasChanges,
    etag: remote.etag,
    sitemapLastModMap: remote.sitemapLastModMap,
    totalPages: remote.totalPages,
    pagesToAdd: Array.isArray(remote.pagesToAdd) ? remote.pagesToAdd : [],
    pagesToUpdate: Array.isArray(remote.pagesToUpdate) ? remote.pagesToUpdate : [],
    pagesToRemove: Array.isArray(remote.pagesToRemove) ? remote.pagesToRemove : [],
    totalChanged: typeof remote.totalChanged === 'number' ? remote.totalChanged : 0,
  };
}
