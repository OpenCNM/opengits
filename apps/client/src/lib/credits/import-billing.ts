import { estimateRequiredCredits } from '@/lib/credits-config';
import type { DynamicCreditsConfig } from '@/lib/credits-config';

// Shared billing classifier keeps upfront credit estimation and post-import settlement in sync.
export function isCodePedagogyBilling(params: {
  teachingDepth?: string | null;
  ingestMode?: string | null;
}): boolean {
  return Boolean(
    (params.teachingDepth && params.teachingDepth !== 'overview') ||
      params.ingestMode === 'code_only'
  );
}

// Settles against actual processed size without clamping to frozen upfront estimates.
export function settleImportBilling(params: {
  actualDocCount: number;
  actualChars?: number;
  isPublic: boolean;
  teachingDepth?: string | null;
  ingestMode?: string | null;
  config: DynamicCreditsConfig;
}): ReturnType<typeof estimateRequiredCredits> {
  const chars = params.actualChars ?? 0;
  const chunks = Number.isSafeInteger(chars) && chars > 0
    ? Math.ceil(chars / Math.max(1, params.config.standardChunkCharSize)) : 0;
  const multiplier = isCodePedagogyBilling(params) ? params.config.codePedagogyMultiplier : 1;
  const baseCredits = Math.ceil(chunks * multiplier);
  const cap = Math.max(0, params.config.maxCreditsPerImport);
  return {
    estimatedChunks: chunks,
    baseCredits,
    finalCredits: 0,
    rewardCredits: params.isPublic ? Math.min(baseCredits, cap) : 0,
    discountApplied: params.isPublic,
  };
}
