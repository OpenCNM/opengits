import { CHAPTER_UPDATE_JOB_STATUS, ACTIVE_JOB_STATUSES } from '@/lib/state/status-vocabularies';
import type { ChapterUpdateJobStatus } from '@/lib/state/status-vocabularies';
import { assertNever } from './exhaustive';
import type {
  ChapterUpdateLifecycleInput,
  ChapterUpdateLifecycleProjection,
  ChapterUpdatePhase,
  ClaimTranscribePollInput,
  ClaimTranscribePollResult,
  ClaimTranscribePollStatus,
  RelayTaskPhase,
} from './chapter-update-lifecycle-contract';

export type { ChapterUpdatePhase, ClaimTranscribePollStatus, RelayTaskPhase };

/**
 * 合法迁移表 —— Go internal/market/states.go chapterUpdateJobTransitions 的逐字镜像。
 * 单向依赖：Go 为 SSOT（写路径守卫），TS 只读消费（展示/轮询投影）。
 * 同步锁：tests/unit/chapter-update-lifecycle.test.ts 解析 Go 源文件强制对拍。
 */
export const CHAPTER_UPDATE_JOB_TRANSITIONS: Readonly<
  Record<ChapterUpdateJobStatus, readonly ChapterUpdateJobStatus[]>
> = {
  PENDING: ['CLAIMED'],
  // CLAIMED→TRIAL 已随「试读与表决」退役拆除（2026-11）：不再产生新 TRIAL，
  // 存量 TRIAL 行由 TRIAL→{SWAPPED,REJECTED,FAILED} 排水收敛
  CLAIMED: ['PENDING', 'SWAPPED', 'FAILED'],
  TRIAL: ['SWAPPED', 'REJECTED', 'FAILED'],
  SWAPPED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [], // 死态：枚举存在、双端零写入
};

/** 迁移合法性判定（镜像 Go CanTransition） */
export function canTransitionChapterUpdateJob(
  from: string,
  to: string
): boolean {
  const targets = CHAPTER_UPDATE_JOB_TRANSITIONS[from as ChapterUpdateJobStatus];
  if (!targets) return false;
  return targets.includes(to as ChapterUpdateJobStatus);
}

/** 终态判定（SWAPPED/REJECTED/FAILED/CANCELLED；镜像 Go IsTerminal） */
export function isTerminalChapterUpdateJob(status: string): boolean {
  const targets = CHAPTER_UPDATE_JOB_TRANSITIONS[status as ChapterUpdateJobStatus];
  return targets !== undefined && targets.length === 0;
}


function toTime(value: Date | string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * 章节更新任务生命周期投影（纯函数）：
 * 7 态 + 租约事实 → 客户端细粒度相位。
 * 'APPLIED' 为历史遗留完成态（不在 Go 7 态表内），按 SWAPPED 完成语义归并。
 */
export function projectChapterUpdateLifecycle(
  input: ChapterUpdateLifecycleInput
): ChapterUpdateLifecycleProjection {
  const raw = input.status ?? null;
  const now = input.now !== undefined ? toTime(input.now, Date.now()) : Date.now();
  const leaseExpired =
    raw === CHAPTER_UPDATE_JOB_STATUS.CLAIMED &&
    input.claimedUntil != null &&
    toTime(input.claimedUntil) < now;

  let phase: ChapterUpdatePhase;
  switch (raw) {
    case 'APPLIED': // 历史遗留完成态：归并 SWAPPED 语义
    case CHAPTER_UPDATE_JOB_STATUS.SWAPPED:
      phase = 'SWAPPED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.REJECTED:
      phase = 'REJECTED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.FAILED:
      phase = 'FAILED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.CANCELLED:
      phase = 'CANCELLED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.TRIAL:
      phase = 'TRIAL_LEGACY';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.CLAIMED:
      phase = leaseExpired ? 'CLAIMED_STALE' : 'CLAIMED_ACTIVE';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.PENDING:
      phase = 'PENDING';
      break;
    default:
      phase = 'UNKNOWN';
      break;
  }

  const isActive =
    phase === 'CLAIMED_ACTIVE' || phase === 'CLAIMED_STALE' || phase === 'TRIAL_LEGACY' || phase === 'PENDING';
  const isTerminal =
    phase === 'SWAPPED' || phase === 'REJECTED' || phase === 'FAILED' || phase === 'CANCELLED';

  return { phase, isActive, isTerminal, leaseStale: phase === 'CLAIMED_STALE' };
}

/**
 * claim-transcribe 轮询投影（纯函数）：吸收 GET 路由两分支的手写状态折叠，
 * 输出与既有 API 响应逐字兼容的三态 + 错误文案。
 * 相位消费为穷尽 switch——新增相位将在此编译失败，杜绝静默落入兜底分支。
 */
export function projectClaimTranscribePoll(
  input: ClaimTranscribePollInput
): ClaimTranscribePollResult {
  const lifecycle = projectChapterUpdateLifecycle({
    status: input.jobStatus,
    claimedUntil: input.claimedUntil,
    now: input.now,
  });

  // 1. 物理文档 PROCESSED 或任务已换入（SWAPPED/APPLIED 遗留）→ 完成
  if (input.docProcessed || lifecycle.phase === 'SWAPPED') {
    return { status: 'completed' };
  }

  // 2. 其余相位穷尽折叠（SWAPPED 已被上方 docProcessed 分支的类型收窄排除）
  switch (lifecycle.phase) {
    case 'CLAIMED_ACTIVE':
      return { status: 'running' };
    case 'CLAIMED_STALE':
      return { status: 'failed', error: '认领超时，任务已回池' };
    case 'FAILED':
      return { status: 'failed', error: input.errorMessage || '转录失败' };
    case 'PENDING':
    case 'TRIAL_LEGACY':
    case 'REJECTED':
    case 'CANCELLED':
    case 'UNKNOWN':
      if (input.jobStatus === null || input.jobStatus === undefined) {
        return { status: 'failed', error: '任务不存在或已失效' };
      }
      return { status: 'failed', error: '任务状态异常' };
    default:
      return assertNever(lifecycle.phase, 'projectClaimTranscribePoll');
  }
}

/**
 * 接力任务追踪相位派生（relay-task-store 的展示状态从事实推导）：
 * result 已落 → completed；error 已落 → failed；否则 running。
 */
export function deriveRelayTaskPhase(facts: {
  result?: unknown | null;
  error?: string | null;
}): RelayTaskPhase {
  if (facts.result !== null && facts.result !== undefined) return 'completed';
  if (facts.error) return 'failed';
  return 'running';
}
