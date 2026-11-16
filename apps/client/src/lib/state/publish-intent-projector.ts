import type { PublishIntentInput, PublishIntentState } from './publish-intent-contract';

/**
 * 发布意图纯投影器：客户端自动发布 effect 与服务端 ingest-status 闭环自愈
 * 共同消费的唯一判定点——「是否应当自动提交发布」的物理条件从此只有一处编码
 * （projectPublishIntent(...) === 'READY_TO_SUBMIT'），杜绝两处手拼四条件漂移。
 *
 * 规则（优先级序）：
 * 1. isPublic → PUBLISHED（已公开为最强事实）
 * 2. REJECTED → REJECTED（驳回终局，人工重提通道）
 * 3. PENDING → PENDING_REVIEW（审核中/withdraw 重审中）
 * 4. APPROVED 但未公开 → INELIGIBLE（事务不一致，禁止自动动作）
 * 5. publishRequested && allProcessed && (reviewStatus 为 NONE/空) → READY_TO_SUBMIT
 * 6. 其余（无意图 / 转录未完成 / 私有是主动选择）→ IDLE
 */
export function projectPublishIntent(input: PublishIntentInput): PublishIntentState {
  const { publishRequested, isPublic, reviewStatus, allProcessed } = input;

  if (isPublic) {
    return 'PUBLISHED';
  }
  if (reviewStatus === 'REJECTED') {
    return 'REJECTED';
  }
  if (reviewStatus === 'PENDING') {
    return 'PENDING_REVIEW';
  }
  if (reviewStatus === 'APPROVED') {
    return 'INELIGIBLE';
  }
  // reviewStatus 为 NONE / null / undefined（无审核记录）
  if (publishRequested && allProcessed) {
    return 'READY_TO_SUBMIT';
  }
  return 'IDLE';
}
