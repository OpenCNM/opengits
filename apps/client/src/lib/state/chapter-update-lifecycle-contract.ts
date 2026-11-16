import type { ChapterUpdateJobStatus } from '@/lib/state/status-vocabularies';

/**
 * 章节更新市场生命周期契约（TS 侧镜像，SSOT 为 Go
 * services/worker-sidecar/internal/market/states.go 的迁移表；
 * 逐字同步由 tests/unit/chapter-update-lifecycle.test.ts 强制锁定）。
 */
export type { ChapterUpdateJobStatus };

/**
 * 客户端细粒度相位（在 7 态之上叠加「租约过期」的本地感知）：
 * - CLAIMED_ACTIVE：已认领且租约有效（正在转录）
 * - CLAIMED_STALE：已认领但租约已过 —— 物理上已被/即将被 Go sweep 回池
 * - TRIAL_LEGACY：试读表决时代存量排水行（不再新增）
 */
export type ChapterUpdatePhase =
  | 'PENDING'
  | 'CLAIMED_ACTIVE'
  | 'CLAIMED_STALE'
  | 'TRIAL_LEGACY'
  | 'SWAPPED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** 生命周期投影输入（时间作为事实传入，投影器零时钟依赖） */
export interface ChapterUpdateLifecycleInput {
  status?: string | null;
  claimedUntil?: Date | string | null;
  now?: Date | number;
}

export interface ChapterUpdateLifecycleProjection {
  phase: ChapterUpdatePhase;
  /** 占用认领租约/试读窗、未终态（对应 Go ActiveStatuses 口径） */
  isActive: boolean;
  isTerminal: boolean;
  /** CLAIMED 且租约已过（客户端可据此提示「任务已回池」） */
  leaseStale: boolean;
}

/** claim-transcribe 轮询三态（API 响应字面量，兼容既有客户端） */
export type ClaimTranscribePollStatus = 'running' | 'completed' | 'failed';

export interface ClaimTranscribePollInput {
  /** 物理文档已 PROCESSED（最强完成事实，优先于 job 状态） */
  docProcessed: boolean;
  jobStatus?: string | null;
  claimedUntil?: Date | string | null;
  errorMessage?: string | null;
  now?: Date | number;
}

export interface ClaimTranscribePollResult {
  status: ClaimTranscribePollStatus;
  error?: string;
}

/** 接力任务追踪（relay-task-store）的三态展示词汇 */
export type RelayTaskPhase = 'running' | 'completed' | 'failed';
