import { WebDocDiffResult } from './types';
import { executeSidecarWebDocDiff } from '../web-doc-driver';

export interface PreviousSyncState {
  etag?: string;
  sitemapLastMod?: Record<string, string>;
  contentHashes?: Record<string, string>;
}

export async function detectWebDocDiff(
  rootUrl: string,
  previousState: PreviousSyncState = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WebDocDiffResult> {
  return await executeSidecarWebDocDiff(rootUrl, previousState, options);
}
