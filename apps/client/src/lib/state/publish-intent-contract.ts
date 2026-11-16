import type { ReviewStatus } from '@/lib/review/config';

/**
 * 发布意图投影输入（全部为物理事实，零时钟零请求）。
 */
export interface PublishIntentInput {
  /** 用户在导入/发布时勾选的公开意图（延期执行意图，落库于 Repository.publishRequested） */
  publishRequested?: boolean | null;
  /** 仓库当前是否公开（isPublic 物理事实） */
  isPublic?: boolean | null;
  /** 平台安全审核状态（NONE/PENDING/APPROVED/REJECTED） */
  reviewStatus?: ReviewStatus | string | null;
  /** 全部章节已物理转录完成（total>0 且 processed===total） */
  allProcessed?: boolean;
}

/**
 * 发布意图宏观状态（单一仲裁点）：
 * - IDLE：无公开意图或意图尚不可执行（转录未完成）——不触发任何动作
 * - READY_TO_SUBMIT：自动发布唯一触发条件（意图明确 + 全部就绪 + 未公开 + 无审核记录）
 * - PENDING_REVIEW：审核中（含主动 withdraw 后的重审）
 * - PUBLISHED：已公开
 * - REJECTED：审核驳回（可人工重提）
 * - INELIGIBLE：物理事实自相矛盾（如 APPROVED 但未公开），禁止自动动作，留人工排查
 */
export type PublishIntentState =
  | 'IDLE'
  | 'READY_TO_SUBMIT'
  | 'PENDING_REVIEW'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'INELIGIBLE';
