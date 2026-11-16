/**
 * apps/client/src/engine/llms-txt-driver.ts
 *
 * llms.txt / llms-full.txt 知识导出引擎驱动（TypeScript 端向 Go worker-sidecar 发起生成调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（POST /v1/llms-txt/generate），
 *    消除 Node.js V8 堆内存搬运开销与 GC 停顿（Zero-Heap-Churn）；
 * 2. Fail-Closed 单实现（2026-09-11 收刀）：本地 TS generateLlmsTxt 已物理删除
 *    （Go pgx store 同位自查），sidecar 故障显式抛 SidecarError；
 * 3. 严格遵循契约：输入与输出结构在 sidecar 与本地降级路径间保持 100% 幂等。
 */

import { callSidecar } from '../lib/sidecar-client';

interface SidecarLlmsTxtRequest {
  repositoryId: string;
  owner: string;
  repo: string;
  version?: string;
  baseUrl: string;
  full?: boolean;
  budget?: number;
  topic?: string;
  mode?: 'strict' | 'balanced';
  userId?: string | null;
}

interface SidecarLlmsTxtResult {
  content: string;
  estimatedTokens: number;
  downgradedCount: number;
  targetVersion: string;
}

interface SidecarLlmsTxtDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 通过 Go worker-sidecar 生成 llms.txt / llms-full.txt。
 * Fail-Closed 单实现：sidecar 故障显式抛 SidecarError。
 */
export async function executeSidecarLlmsTxt(
  req: SidecarLlmsTxtRequest,
  options?: SidecarLlmsTxtDriverOptions
): Promise<SidecarLlmsTxtResult | null> {
  const payload = {
    repositoryId: req.repositoryId,
    owner: req.owner,
    repo: req.repo,
    version: req.version,
    baseUrl: req.baseUrl,
    full: req.full ?? false,
    budget: req.budget,
    topic: req.topic,
    mode: req.mode,
    userId: req.userId ?? undefined,
  };

  return await callSidecar<SidecarLlmsTxtResult>(
    '/v1/llms-txt/generate',
    payload,
    {
      label: 'llms-txt /v1/llms-txt/generate',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}
