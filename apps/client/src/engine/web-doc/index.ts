import { WebDocDiffResult } from './types';
import { detectWebDocDiff, PreviousSyncState } from './diff-detector';

export * from './types';
export * from './diff-detector';

/**
 * Web 文档上游差分探测引擎 (WebDocEngine)
 *
 * 抓取/结构化/图片转存/robots 合规已全量下沉 Go worker-sidecar（internal/webdoc，
 * FastPath BFS → Firecrawl → Fail-Closed 终局梯子，Zero-Node Worker）；
 * TS 侧仅保留更新管线的 sitemap/etag 轻探测差分链：
 * web-doc-job.probeWebDocUpstream → detectDiff → /v1/web-doc/diff。
 */
export class WebDocEngine {
  /**
   * 独立增量变更差分检测
   */
  async detectDiff(
    url: string,
    previousState: PreviousSyncState = {},
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<WebDocDiffResult> {
    return detectWebDocDiff(url, previousState, options);
  }
}

// 导出全局单例
export const webDocEngine = new WebDocEngine();
