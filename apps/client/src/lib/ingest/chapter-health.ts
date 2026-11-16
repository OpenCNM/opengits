export const CHAPTER_STALL_THRESHOLD_MS = 90_000;

export interface ChapterHealthInput {
  docStatus: string | null | undefined;
  jobStatus: string | null | undefined;
  hasActiveRepoSibling: boolean;
  serverUpdatedAtMs: number | null;
  fallbackActivityMs: number;
  nowMs: number;
  stallThresholdMs?: number;
}

export interface ChapterHealthVerdict {
  /** 本章处于健康的排队等待态（自身已入队或同仓存在正在转录的兄弟章节） */
  isHealthyQueued: boolean;
  /** 本章确凿停滞：PROCESSING 心跳超时，或 UNPROCESSED 且整仓无活跃执行者超过阈值 */
  isStalled: boolean;
}

/**
 * 基于服务端物理事实判定未完成章节的健康状态（纯函数，无客户端挂载时钟幻觉）：
 * 1. UNPROCESSED 态：只要自身已入队（QUEUED/RUNNING）或同仓有兄弟章节正在执行（hasActiveRepoSibling），
 *    即属健康排队，绝不触发假超时；仅当整仓无任何活跃调度且持续静默超阈值时，才判定为孤儿停滞。
 * 2. PROCESSING 态：优先以服务端心跳时间 serverUpdatedAtMs 判活，跨路由切换不丢状态。
 */
export function evaluateChapterTranscriptionHealth(input: ChapterHealthInput): ChapterHealthVerdict {
  const {
    docStatus,
    jobStatus,
    hasActiveRepoSibling,
    serverUpdatedAtMs,
    fallbackActivityMs,
    nowMs,
    stallThresholdMs = CHAPTER_STALL_THRESHOLD_MS,
  } = input;

  if (docStatus === 'PROCESSED' || docStatus === 'ERROR') {
    return { isHealthyQueued: false, isStalled: false };
  }

  if (docStatus !== 'PROCESSING') {
    const isHealthyQueued =
      jobStatus === 'QUEUED' ||
      jobStatus === 'RUNNING' ||
      hasActiveRepoSibling;

    if (isHealthyQueued) {
      return { isHealthyQueued: true, isStalled: false };
    }

    const refMs =
      serverUpdatedAtMs && serverUpdatedAtMs > 0
        ? serverUpdatedAtMs
        : fallbackActivityMs;
    return {
      isHealthyQueued: false,
      isStalled: nowMs - refMs > stallThresholdMs,
    };
  }

  const refMs =
    serverUpdatedAtMs && serverUpdatedAtMs > 0
      ? serverUpdatedAtMs
      : fallbackActivityMs;

  return {
    isHealthyQueued: false,
    isStalled: nowMs - refMs > stallThresholdMs,
  };
}
