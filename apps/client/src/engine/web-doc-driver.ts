/**
 * apps/client/src/engine/web-doc-driver.ts
 *
 * WebDoc 增量差分引擎驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/web-doc/diff），消除 Node.js V8 堆内存开销与事件循环阻塞；
 * 2. Fail-Closed 单实现：抓取执行（快道/Firecrawl/图片转存/robots）已全量下沉 Go
 *    internal/webdoc 进程内承载，TS 侧仅保留差分探测代理；
 *    sidecar 故障显式抛 SidecarError（观测经共享 sidecar-client 统一记录，绝不静默）；
 * 3. 严格遵循契约：输入与输出结构由冻结夹具与 Go 单端断言锁定；
 * 4. 驱动层单次超时默认 10,000ms。
 */

import { callSidecar } from '../lib/sidecar-client';
import type { WebDocDiffResult } from './web-doc/types';
import type { PreviousSyncState } from './web-doc/diff-detector';

const DEFAULT_TIMEOUT_MS = 10_000;

/** 差分代理的调用参数（sidecar-client 的 SidecarCallOptions 含必填观测 label，此处收窄） */
interface WebDocDiffCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 委托 Go worker-sidecar 执行 Sitemap 增量差分检测。
 * 命中 304 或正常差分返回 WebDocDiffResult（Fail-Closed：故障显式抛 SidecarError）。
 */
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

