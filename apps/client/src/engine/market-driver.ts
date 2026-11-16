/**
 * apps/client/src/engine/market-driver.ts
 *
 * 更新市场状态机流转驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构规范：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/market/jobs/* 等），
 *    在 Go 侧执行高并发原子 CAS 事务（SettleRelayTx）与文档晋升；
 * 2. 统一使用 callSidecar 传输层（内置 INTERNAL_API_TOKEN 鉴权、超时与错误处理）；
 * 3. 驱动层失败显式抛出 SidecarError，由调用方（jobs.ts）实现透明的 Fail-Open 本地回退降级。
 */

import { callSidecar } from '@/lib/sidecar-client';

interface MarketDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// 注：市场超时清扫与存量 TRIAL 排水不再有 Node HTTP 桥接（2026-11 外围
// 清理收敛）——由 Go sidecar 单写者自治（orphan-sweeper 60s 互斥 +
// auto-update runner 周期直调 SettleExpiredMarketTrials）。

// ── Phase 10: 更新市场状态机单写者驱动方法 ────────────────────────

interface ActiveJobItem {
  id: string;
  documentId: string;
  path: string;
  status: string;
  kind: string;
  fromSha: string;
  toSha: string;
  claimedBy: string | null;
  voteDeadline: string | null;
  frozenCredits: number;
  document?: {
    title: string;
  };
}

interface RelayJobItem {
  id: string;
  repositoryId: string;
  kind: string;
  status: string;
}

export async function executeSidecarMarketJobsList(
  repositoryId: string,
  options?: MarketDriverOptions
): Promise<{ jobs: ActiveJobItem[] }> {
  const res = await callSidecar<{ ok: boolean; jobs: ActiveJobItem[] }>(
    '/v1/market/jobs/list',
    { repositoryId },
    {
      label: 'market-driver /v1/market/jobs/list',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return { jobs: res.jobs || [] };
}

export interface JobAuthInfo {
  id: string;
  repositoryId: string;
  kind: string;
  status: string;
  isPublic: boolean;
}

export async function executeSidecarMarketJobAuthInfo(
  jobId: string,
  options?: MarketDriverOptions
): Promise<JobAuthInfo> {
  return await callSidecar<JobAuthInfo>(
    '/v1/market/jobs/auth-info',
    { jobId },
    {
      label: 'market-driver /v1/market/jobs/auth-info',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}

export async function executeSidecarMarketJobClaim(
  jobId: string,
  userId: string,
  ttlMinutes = 120,
  options?: MarketDriverOptions
): Promise<{ frozenCredits: number }> {
  const res = await callSidecar<{ ok: boolean; frozenCredits: number }>(
    '/v1/market/jobs/claim',
    { jobId, userId, ttlMinutes },
    {
      label: 'market-driver /v1/market/jobs/claim',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return { frozenCredits: res.frozenCredits };
}

export async function executeSidecarMarketJobRelease(
  jobId: string,
  userId: string,
  options?: MarketDriverOptions
): Promise<void> {
  await callSidecar<{ ok: boolean }>(
    '/v1/market/jobs/release',
    { jobId, userId },
    {
      label: 'market-driver /v1/market/jobs/release',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}

/**
 * 认领租约续期（CAS：仅本人持有且未过期的 CLAIMED 可续）。ok=false 表示租约
 * 已丢失/过期（回池语义既成事实）——非错误，调用方据此停止后续续期。
 * 2026-10-13 批量接力异步执行器随附（覆盖进程内队列的排队耗时）。
 */
export async function executeSidecarMarketJobExtendClaim(
  jobId: string,
  userId: string,
  ttlMinutes = 120,
  options?: MarketDriverOptions
): Promise<{ extended: boolean }> {
  const res = await callSidecar<{ ok: boolean }>(
    '/v1/market/jobs/extend-claim',
    { jobId, userId, ttlMinutes },
    {
      label: 'market-driver /v1/market/jobs/extend-claim',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return { extended: Boolean(res.ok) };
}

export async function executeSidecarMarketJobRelaySettle(
  input: {
    jobId: string;
    userId: string;
    documentId: string;
    repositoryId: string;
    stagedContentId: string;
    stagedModel: string;
    toSha: string;
    dualWrite: boolean;
  },
  options?: MarketDriverOptions
): Promise<void> {
  await callSidecar<{ ok: boolean }>(
    '/v1/market/jobs/relay-settle',
    input,
    {
      label: 'market-driver /v1/market/jobs/relay-settle',
      timeoutMs: options?.timeoutMs ?? 30_000,
      signal: options?.signal,
    }
  );
}

export async function executeSidecarMarketJobMarkFailed(
  jobId: string,
  userId: string,
  errorMessage: string,
  options?: MarketDriverOptions
): Promise<void> {
  await callSidecar<{ ok: boolean }>(
    '/v1/market/jobs/mark-failed',
    { jobId, userId, errorMessage },
    {
      label: 'market-driver /v1/market/jobs/mark-failed',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}

export async function executeSidecarMarketJobEnsureRelay(
  documentId: string,
  options?: MarketDriverOptions
): Promise<{ id: string; repositoryId: string; kind: string; status: string }> {
  const res = await callSidecar<{ ok: boolean; job: RelayJobItem }>(
    '/v1/market/jobs/ensure-relay',
    { documentId },
    {
      label: 'market-driver /v1/market/jobs/ensure-relay',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return res.job;
}

export async function executeSidecarMarketJobRetranslateRecord(
  input: {
    repositoryId: string;
    documentId: string;
    path: string;
    gitSha: string | null;
    userId: string;
    contentId: string;
    stagedModel: string | null;
  },
  options?: MarketDriverOptions
): Promise<void> {
  await callSidecar<{ ok: boolean }>(
    '/v1/market/jobs/retranslate-record',
    {
      repositoryId: input.repositoryId,
      documentId: input.documentId,
      path: input.path,
      gitSha: input.gitSha ?? '',
      userId: input.userId,
      stagedContentId: input.contentId,
      stagedModel: input.stagedModel ?? '',
    },
    {
      label: 'market-driver /v1/market/jobs/retranslate-record',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}

export async function executeSidecarMarketJobCreateStale(
  input: {
    repositoryId: string;
    fromSha: string;
    toSha: string;
    paths: string[];
  },
  options?: MarketDriverOptions
): Promise<{ created: number; structural: boolean }> {
  const res = await callSidecar<{ ok: boolean; created: number; structural: boolean }>(
    '/v1/market/jobs/create-stale',
    input,
    {
      label: 'market-driver /v1/market/jobs/create-stale',
      timeoutMs: options?.timeoutMs ?? 30_000,
      signal: options?.signal,
    }
  );
  return { created: res.created, structural: res.structural };
}

// ── Phase 12: 章节版本协同治理单写者驱动方法 ────────────────────────

interface SidecarChapterVersionCreateInput {
  documentId: string;
  repositoryId: string;
  authorId: string;
  contentId: string;
  source?: string;
  visibility?: string;
}

export async function executeSidecarChapterVersionCreate(
  input: SidecarChapterVersionCreateInput,
  options?: MarketDriverOptions
): Promise<{ versionId: string }> {
  const res = await callSidecar<{ ok: boolean; versionId: string; error?: string }>(
    '/v1/chapter-versions/create',
    input,
    {
      label: 'market-driver /v1/chapter-versions/create',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  if (!res.ok || !res.versionId) {
    throw new Error(res.error || 'Failed to create chapter version');
  }
  return { versionId: res.versionId };
}

export async function executeSidecarChapterVersionPublish(
  input: { versionId: string; userId: string },
  options?: MarketDriverOptions
): Promise<{ notFound?: boolean; forbidden?: boolean; base: number }> {
  const res = await callSidecar<{
    ok: boolean;
    notFound?: boolean;
    forbidden?: boolean;
    base: number;
    error?: string;
  }>(
    '/v1/chapter-versions/publish',
    input,
    {
      label: 'market-driver /v1/chapter-versions/publish',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return {
    notFound: res.notFound,
    forbidden: res.forbidden,
    base: res.base ?? 0,
  };
}

export async function executeSidecarChapterVersionDelete(
  input: { versionId: string; userId: string },
  options?: MarketDriverOptions
): Promise<{ notFound?: boolean; forbidden?: boolean; invalidState?: boolean }> {
  const res = await callSidecar<{
    ok: boolean;
    notFound?: boolean;
    forbidden?: boolean;
    invalidState?: boolean;
    error?: string;
  }>(
    '/v1/chapter-versions/delete',
    input,
    {
      label: 'market-driver /v1/chapter-versions/delete',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return {
    notFound: res.notFound,
    forbidden: res.forbidden,
    invalidState: res.invalidState,
  };
}

interface SidecarChapterVersionPinResult {
  found: boolean;
  forbidden: boolean;
  success: boolean;
  flipped: boolean;
  reason?: string;
  documentId?: string;
  postSwapPayload?: {
    repositoryId: string;
    documentId: string;
    path: string;
    contentId: string;
    content: string;
  };
}

export async function executeSidecarChapterVersionPin(
  input: { versionId: string; userId: string; isAdmin?: boolean },
  options?: MarketDriverOptions
): Promise<SidecarChapterVersionPinResult> {
  const res = await callSidecar<{
    ok: boolean;
    notFound?: boolean;
    forbidden?: boolean;
    success?: boolean;
    flipped?: boolean;
    reason?: string;
    documentId?: string;
    postSwapPayload?: {
      repositoryId: string;
      documentId: string;
      path: string;
      contentId: string;
      content: string;
    };
    error?: string;
  }>(
    '/v1/chapter-versions/pin',
    input,
    {
      label: 'market-driver /v1/chapter-versions/pin',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return {
    found: !res.notFound,
    forbidden: !!res.forbidden,
    success: !!res.success,
    flipped: !!res.flipped,
    reason: res.reason,
    documentId: res.documentId,
    postSwapPayload: res.postSwapPayload,
  };
}

interface SidecarChapterVersionPromoteInput {
  documentId: string;
  targetVersionId?: string;
  isPinOperation?: boolean;
  operatorUserId?: string;
  flipMargin?: number;
}

interface SidecarChapterVersionPromoteResult {
  flipped: boolean;
  canonicalVersionId?: string;
  previousVersionId?: string;
  reason?: string;
  postSwapPayload?: {
    repositoryId: string;
    documentId: string;
    path: string;
    contentId: string;
    content: string;
  };
}

export async function executeSidecarChapterVersionPromote(
  input: SidecarChapterVersionPromoteInput,
  options?: MarketDriverOptions
): Promise<SidecarChapterVersionPromoteResult> {
  const res = await callSidecar<{
    ok: boolean;
    flipped?: boolean;
    canonicalVersionId?: string;
    previousVersionId?: string;
    reason?: string;
    postSwapPayload?: {
      repositoryId: string;
      documentId: string;
      path: string;
      contentId: string;
      content: string;
    };
    error?: string;
  }>(
    '/v1/chapter-versions/promote',
    input,
    {
      label: 'market-driver /v1/chapter-versions/promote',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
  return {
    flipped: !!res.flipped,
    canonicalVersionId: res.canonicalVersionId,
    previousVersionId: res.previousVersionId,
    reason: res.reason,
    postSwapPayload: res.postSwapPayload,
  };
}

