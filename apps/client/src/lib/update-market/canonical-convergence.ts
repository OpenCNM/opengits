// Serializes canonical swaps inside Go pg_advisory_xact_lock to avoid Node lock contention and dual writes.

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
