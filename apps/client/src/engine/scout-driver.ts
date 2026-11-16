/**
 * apps/client/src/engine/scout-driver.ts
 *
 * Scout 探测阶段万级文件树与规则画像驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/scout/inspect），实现 Zero-Tree-Transport
 *    （零万级目录树 V8 跨进程搬运），彻底消除大量节点在 Node.js 与 Sidecar 间的序列化损耗与 GC 停顿；
 * 2. 紧凑决策返回（< 50KB）：Go 端直接返回受限深度 DirTree、scoped markdownFiles、ExclusionReport、
 *    RepoProfile 与用于同源比对的骨架特征（skeleton / skeletonHash）；
 * 3. 驱动层显式抛 SidecarError，调用管道（run-scout-pipeline）统一收口透明容灾与 Fail-Open 降级。
 */

import { callSidecar, type SidecarCallOptions } from '../lib/sidecar-client';
import type { GitHubNode, ExclusionReport } from './fetcher';
import type { RepoProfile, ScaleDecision } from './repo-sniffer';
import type { DirTreeNode } from '../lib/dir-verdict';

interface ScoutInspectParams {
  owner: string;
  repo: string;
  branch?: string;
  sha?: string | null;
  token?: string;
  prefixFilter?: string;
  filePath?: string;
  singleDocMode?: boolean;
  maxDepth?: number;
  stars?: number;
  forks?: number;
}

interface ScoutInspectResponse {
  ok: boolean;
  archiveUsed: boolean;
  totalNodeCount: number;
  markdownFiles: GitHubNode[];
  profile: RepoProfile;
  scale: ScaleDecision;
  dirTree: DirTreeNode[];
  exclusionReport: ExclusionReport;
  skeleton: string;
  skeletonHash: string;
  truncated: boolean;
  reputation?: {
    tier: 'high' | 'standard' | 'suspicious';
    reason: string;
    quotas: {
      maxUnpackCapBytes: number;
      maxFiles: number;
      allowGiantScope: boolean;
    };
    isClassic: boolean;
    isRejected: boolean;
  };
  readmeSnippet?: string;
}

interface ScoutDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 执行 Go worker-sidecar 探测与画像提取。
 * @throws {SidecarError} sidecar 未就绪、超时或返回错误时抛出，由调用层执行 Fail-Open 降级。
 */
export async function executeSidecarScoutInspect(
  params: ScoutInspectParams,
  options?: ScoutDriverOptions
): Promise<ScoutInspectResponse> {
  const payload = {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    sha: params.sha || undefined,
    token: params.token,
    prefixFilter: params.prefixFilter,
    filePath: params.filePath,
    singleDocMode: params.singleDocMode,
    maxDepth: params.maxDepth,
    stars: params.stars,
    forks: params.forks,
  };

  const res = await callSidecar<ScoutInspectResponse>(
    '/v1/scout/inspect',
    payload,
    {
      label: 'scout /v1/scout/inspect',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );

  if (!res.ok) {
    throw new Error('scout /v1/scout/inspect: response ok is false');
  }

  return res;
}
