/**
 * apps/client/src/engine/update-candidate-driver.ts
 *
 * 增量更新候选集与差异比对一站式驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/update/candidate-set），
 *    在 Go 内存中一站式完成重聚类（cluster_recompute）、图谱语义漂移（diff_engine）、
 *    代码/文档章节反查、确定性 rename 吸收与规则级 keep 豁免；
 * 2. 彻底消除 Node.js 与 Sidecar 之间的多轮跨进程 RPC 乒乓往返（Zero-Ping-Pong）
 *    与大版本跨度下的 V8 堆内存集合风暴（Zero-Set-Churn）；
 * 3. Fail-Closed 单实现（2026-09-11 收刀）：本地 TypeScript 纯函数双轨已物理删除，
 *    sidecar 故障显式抛 SidecarError（修复动作在 Go 端）；
 * 4. 严格遵循契约：输入与输出结构由冻结夹具与 Go 单端断言锁定。
 */

import { callSidecar } from '../lib/sidecar-client';
import type { BuildUpdateCandidateSetParams, UpdateCandidateSet } from './update-candidate-set';
import type { ApplyUpdatePlanParams, ApplyUpdateResult } from './update-applier';

interface UpdateCandidateDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 跨版本增量更新候选集一站式提取（Go worker-sidecar 单实现，Fail-Closed：
 * 本地 TS 实现已物理删除，sidecar 故障显式抛 SidecarError，修复动作在 Go 端）。
 */
export async function executeSidecarCandidateSet(
  params: BuildUpdateCandidateSetParams,
  options?: UpdateCandidateDriverOptions
): Promise<UpdateCandidateSet> {
  const reqPayload = {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    fromSha: params.fromSha,
    toSha: params.toSha,
    repositoryId: params.repositoryId,
    docOwnerId: params.docOwnerId ?? null,
    repoProfile: params.repoProfile ?? null,
    diff: params.diff
      ? {
          added: Array.from(params.diff.added),
          modified: Array.from(params.diff.modified),
          removed: Array.from(params.diff.removed),
          renamed: params.diff.renamed,
        }
      : null,
    newTree: params.newTree ?? null,
    documents: params.documentsOverride ?? null,
  };

  const res = await callSidecar<UpdateCandidateSet>(
    '/v1/update/candidate-set',
    reqPayload,
    {
      label: 'update-candidate /v1/update/candidate-set',
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
    }
  );

  if (
    !Array.isArray(res.chapters) ||
    !Array.isArray(res.unmatchedFiles) ||
    !res.diffStats
  ) {
    throw new Error('update-candidate /v1/update/candidate-set: malformed candidate set payload');
  }

  return res;
}

const APPLY_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 确定性增量更新计划应用（Stage 2 下沉 Go worker-sidecar 原生直写：
 * 在单个 pgx 事务内毫秒级完成 rename 迁移、文档批处理、V2 大纲派生与快照推进，
 * 彻底解耦 Next.js 数据库连接池）。
 */
export async function executeSidecarUpdateApply(
  params: ApplyUpdatePlanParams,
  options?: UpdateCandidateDriverOptions
): Promise<ApplyUpdateResult> {
  const reqPayload = {
    repositoryId: params.repositoryId,
    userId: params.userId,
    docOwnerId: params.docOwnerId ?? null,
    fromSha: params.fromSha,
    toSha: params.toSha,
    plan: params.plan,
    candidateSet: params.candidateSet,
    runId: params.runId ?? null,
  };

  const res = await callSidecar<{ ok: boolean; result: ApplyUpdateResult }>(
    '/v1/update/apply',
    reqPayload,
    {
      label: 'update-applier /v1/update/apply',
      timeoutMs: options?.timeoutMs ?? APPLY_DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
    }
  );

  if (!res || !res.result) {
    throw new Error('update-applier /v1/update/apply: malformed response payload');
  }

  return res.result;
}

