// 职责：归档 sidecar（Go worker-sidecar）的 TS 驱动。
// - 归档下载/解压主权 100% 归 Go worker-sidecar（Fail-Closed 单实现，
//   2026-09-11 收刀：sidecar 故障显式抛 SidecarError，不再静默回落网络路径；
//   超限跳过是合法业务结果 dir=null，调用方走网络路径属产品行为非降级）；
// - sidecar 返回的 dir 是其容器内路径（/storage/repos/...），与本地挂载点不同——
//   调用方一律用本地 archiveDirFor 重算路径，两侧共享同一物理布局 {owner}/{repo}/{sha}。

import { callSidecar } from '../../lib/sidecar-client';

interface SidecarEnsureResponse {
  dir: string | null;
  fromCache: boolean;
}

/**
 * 经 worker-sidecar 确保归档存在（下载/解压在 Go 进程完成，本地卷落盘后由调用方
 * 用本地路径消费）。dir 为 null 表示超限跳过（合法业务结果，调用方走网络路径）；
 * sidecar 故障显式抛 SidecarError。
 */
export async function ensureArchiveViaSidecar(
  owner: string,
  repo: string,
  sha: string,
  options?: { token?: string; signal?: AbortSignal; sizeHintBytes?: number; timeoutMs?: number },
): Promise<{ dir: string | null; fromCache: boolean }> {
  const data = await callSidecar<SidecarEnsureResponse>(
    '/v1/archive/ensure',
    {
      owner,
      repo,
      sha,
      sizeHintBytes: options?.sizeHintBytes ?? 0,
      token: options?.token ?? '',
    },
    {
      label: 'archive /v1/archive/ensure',
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 300_000,
    },
  );
  return { dir: data.dir, fromCache: data.fromCache };
}
