/**
 * apps/client/src/engine/diff-driver.ts
 *
 * 归档目录跨版本差异比对驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式（2026-09-11 收刀裁定）：
 * 1. Zero-Read Disk Diff：归档差异由 Go worker-sidecar（POST /v1/archive/diff）
 *    就地磁盘计算，Node 不再本地遍历哈希整棵归档树；
 * 2. Fail-Closed 单实现：本地 TS Myers/哈希树实现已物理删除——sidecar 故障是
 *    显式 SidecarError（修复动作在 Go 端）；归档缺失（HTTP 404）是合法业务
 *    结果返回 null，与故障显式区分；
 * 3. 契约由冻结夹具 diff-unified.golden.json 锁定（Go 单端断言）。
 */

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

/**
 * 归档目录跨版本差异比对（Go worker-sidecar 单实现，Fail-Closed）。
 * 返回 null 表示归档未落盘（合法业务结果）；sidecar 故障抛 SidecarError。
 */
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
    if (err instanceof SidecarError && err.status === 404) {
      return null; // 归档未落盘：业务 null，非故障
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
