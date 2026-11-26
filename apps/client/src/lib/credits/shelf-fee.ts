import { prisma } from '@/lib/db';
import { CREDITS_CONFIG, getDynamicCreditsConfig } from '@/lib/credits-config';
import { CHAPTER_UPDATE_JOB_STATUS } from '@/lib/schemas/update-job';

export function computeShelfFee(
  ledger: number,
  multiplier: number,
  fallbackDocCount?: number
): number {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return 0;
  const safeMult = Math.max(0, multiplier);
  if (safeMult <= 0) return 0;

  const safeLedger = typeof ledger === 'number' && Number.isFinite(ledger) ? Math.max(0, ledger) : 0;
  const safeDocCount =
    typeof fallbackDocCount === 'number' && Number.isFinite(fallbackDocCount)
      ? Math.max(0, fallbackDocCount)
      : 0;

  // Floor at 1 credit per 2 docs so minimal catalogs cannot bypass shelf fees.
  const baseUnits = Math.max(safeLedger, safeDocCount > 0 ? Math.ceil(safeDocCount * 0.5) : 0);
  if (baseUnits > 0) {
    return Math.max(1, Math.round(baseUnits * safeMult));
  }
  return 0;
}

export function resolveEffectiveShelfFee(params: {
  shelfFeeOverride?: number | null;
  transcriptionCreditsEarned?: number | null;
  shelfFeeMultiplier: number;
  docCount?: number;
}): number {
  if (typeof params.shelfFeeOverride === 'number' && Number.isFinite(params.shelfFeeOverride)) {
    return Math.max(0, Math.round(params.shelfFeeOverride));
  }
  return computeShelfFee(
    params.transcriptionCreditsEarned ?? 0,
    params.shelfFeeMultiplier,
    params.docCount
  );
}

export async function isShelfFeeExempt(userId: string, repositoryId: string): Promise<boolean> {
  const [importRecord, contributed] = await Promise.all([
    prisma.importRecord.findFirst({ where: { userId, repositoryId }, select: { id: true } }),
    prisma.chapterUpdateJob.findFirst({
      where: { repositoryId, claimedBy: userId, status: CHAPTER_UPDATE_JOB_STATUS.SWAPPED },
      select: { id: true },
    }).then((job) => job ?? prisma.chapterVersion.findFirst({
      where: { repositoryId, authorId: userId, visibility: 'PUBLIC' },
      select: { id: true },
    })),
  ]);
  return Boolean(importRecord || contributed);
}

export type ChargeShelfFeeResult =
  | { ok: true; fee: number; signupGift: number; alreadySaved: boolean; balance?: number }
  | { ok: false; code: 'INSUFFICIENT_BALANCE'; fee: number; balance: number };

// Burns permanent creditBalance only; repository importers and contributors are exempt.
export async function chargeShelfFeeAndSave(
  userId: string,
  repositoryId: string,
  autoFollow = true
): Promise<ChargeShelfFeeResult> {
  const existing = await prisma.savedRepo.findUnique({
    where: { userId_repositoryId: { userId, repositoryId } },
    select: { id: true },
  });
  if (existing) return { ok: true, fee: 0, signupGift: 0, alreadySaved: true };

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      isPublic: true,
      transcriptionCreditsEarned: true,
      shelfFeeOverride: true,
      _count: { select: { documents: true } },
    },
  });

  const config = await getDynamicCreditsConfig();
  const exempt =
    !repo?.isPublic ||
    (await isShelfFeeExempt(userId, repositoryId));
  const rawFee = exempt
    ? 0
    : resolveEffectiveShelfFee({
        shelfFeeOverride: repo?.shelfFeeOverride,
        transcriptionCreditsEarned: repo?.transcriptionCreditsEarned,
        shelfFeeMultiplier: config.shelfFeeMultiplier,
        docCount: repo?._count?.documents,
      });
  const fee = typeof rawFee === 'number' && Number.isFinite(rawFee) ? Math.max(0, Math.round(rawFee)) : 0;

  const { executeSidecarShelfFeeCharge } = await import('@/engine/credits-driver');
  const charge = await executeSidecarShelfFeeCharge(userId, repositoryId, fee, autoFollow);
  if (charge.ok && (fee === 0 || charge.alreadySaved)) {
    const { balance: _omitted, ...rest } = charge;
    return rest;
  }
  return charge;
}
