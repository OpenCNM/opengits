/**
 * 排队 ETA 纯函数（多人转录队列透明化）：
 * 输入为 worker 侧事实（排队位置、最近 DONE 平均耗时、断点块进度），
 * 输出「预计约 X 秒后完成」的估算值。无历史耗时（avgJobSeconds=null）时
 * 一律返回 null——不编造数字（fail-closed），UI 退化为只显示排队位置。
 */

export interface QueueEtaInput {
  /** 任务状态（QUEUED | RUNNING）；DONE/FAILED 不参与估算 */
  status: string;
  /** 全局排队位置（1 起；仅 QUEUED 有值；null=不在可认领队列，如仓被暂停） */
  queuePosition?: number | null;
  /** 最近 DONE 任务平均执行耗时（秒）；null=无历史 */
  avgJobSeconds?: number | null;
  /** 断点存档已保存块数（RUNNING 进度估算用） */
  savedChunks?: number;
  /** 本轮切块总数 */
  totalChunks?: number | null;
  /** worker 转录并发槽位数（>0） */
  concurrency: number;
}

/**
 * 估算到「本任务完成」的剩余秒数：
 * - QUEUED：等待批次数 ceil(position/concurrency) × 平均耗时 + 自身平均耗时
 *   （位置 ≤ 并发数时约等于一个平均耗时——槽位空出即开跑）；
 * - RUNNING：有断点进度按剩余块占比 × 平均耗时，无进度按 0.5 × 平均耗时（半程假设）。
 */
export function computeQueueEtaSeconds(input: QueueEtaInput): number | null {
  const avg = input.avgJobSeconds;
  if (typeof avg !== 'number' || avg <= 0) return null;

  if (input.status === 'QUEUED') {
    const position = input.queuePosition;
    if (typeof position !== 'number' || position < 1) return null;
    const concurrency = Math.max(1, input.concurrency);
    const waitBatches = Math.ceil(position / concurrency);
    return Math.round(waitBatches * avg + avg);
  }

  if (input.status === 'RUNNING') {
    const total = input.totalChunks;
    if (typeof total === 'number' && total > 0) {
      const remaining = Math.max(0, total - (input.savedChunks ?? 0));
      return Math.round((remaining / total) * avg);
    }
    return Math.round(avg * 0.5);
  }

  return null;
}
