import { WebDocDiffResult } from './types';
import { executeSidecarWebDocDiff } from '../web-doc-driver';

export interface PreviousSyncState {
  etag?: string;
  sitemapLastMod?: Record<string, string>; // url -> lastmod
  contentHashes?: Record<string, string>;  // path -> contentHash
}

/**
 * 独立的增量变更差分检测器：
 * 委托 Go worker-sidecar 原生执行流式 Sitemap 差分与 ETag 探测（Fail-Closed 单实现）。
 */
export async function detectWebDocDiff(
  rootUrl: string,
  previousState: PreviousSyncState = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WebDocDiffResult> {
  return await executeSidecarWebDocDiff(rootUrl, previousState, options);
}
