/**
 * apps/client/src/lib/update-market/canonical-convergence.ts
 *
 * 章节正典翻正单写者原子收敛尾 (Single-Writer Canonical Convergence Tail)。
 *
 * 物理原则：
 * 1. 异构数据输入（社区投票夺位、维护者钦定置顶、接力首译上架）收敛至单一持久化写者尾。
 * 2. 下沉至 Go worker-sidecar 原生长事务，在 SELECT pg_advisory_xact_lock 保护下串行化。
 * 3. 彻底杜绝 Node 端对 ChapterVersion / Document 产生长事务锁争抢与双写漂移。
 */

import { ENGINE_CONFIG } from '@/lib/config';
import { postSwap } from '@/lib/update-market/jobs';
import { executeSidecarChapterVersionPromote } from '@/engine/market-driver';

export interface CanonicalPromotionParams {
  documentId: string;
  targetVersionId?: string;
  isPinOperation?: boolean;
  operatorUserId?: string;
}

export interface CanonicalPromotionResult {
  flipped: boolean;
  canonicalVersionId?: string;
  previousVersionId?: string;
  reason?:
    | 'ALREADY_CANONICAL'
    | 'MAINTAINER_PINNED_IMMUNE'
    | 'MARGIN_NOT_MET'
    | 'NO_CANDIDATE'
    | 'NOT_FOUND'
    | 'SUCCESS';
}

/**
 * 唯一的正典更替单写者持久化事务尾。
 * 跨所有应用实例串行化排队，保证正典指针与版本标记物理恒等。
 * 下沉至 Go worker-sidecar POST /v1/chapter-versions/promote 执行。
 */
export async function commitCanonicalPromotion(
  params: CanonicalPromotionParams
): Promise<CanonicalPromotionResult> {
  const MARKET = ENGINE_CONFIG.updateMarket;
  const { documentId, targetVersionId, isPinOperation, operatorUserId } = params;

  const promoRes = await executeSidecarChapterVersionPromote({
    documentId,
    targetVersionId,
    isPinOperation,
    operatorUserId,
    flipMargin: MARKET.flipMargin,
  });

  // Re-index postSwap asynchronously outside transaction lock
  if (promoRes.flipped && promoRes.postSwapPayload?.content) {
    const payload = promoRes.postSwapPayload;
    void postSwap(
      {
        repositoryId: payload.repositoryId,
        documentId: payload.documentId,
        path: payload.path,
        stagedContentId: payload.contentId,
      },
      payload.content
    ).catch((e) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(e, { scope: 'version-market/flip-reindex', extra: { documentId } })
      );
    });
  }

  return {
    flipped: promoRes.flipped,
    canonicalVersionId: promoRes.canonicalVersionId,
    previousVersionId: promoRes.previousVersionId,
    reason: promoRes.reason as CanonicalPromotionResult['reason'],
  };
}
