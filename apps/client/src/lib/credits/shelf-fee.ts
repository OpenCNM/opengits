// 书架收费（按教程劳动账本定价）。
//
// 定价：费用 = round(Repository.transcriptionCreditsEarned × shelfFeeMultiplier)，
// 加入时快照（SavedRepo.paidCredits 记实付，幂等不双扣）。价格锚定社区劳动总账
// ——贡献者们实际赚了多少，后来者加入就付多少（系数 1.0 等额，admin 可调）。
// 只扣 User.creditBalance（转录赚的永久余额，不可用日配额垫付——倒逼语义）；
// 收来的积分直接销毁（赚是增发、收是销毁，保持稀缺）。
//
// 豁免（零费用）：① 用户在该仓有 ImportRecord（自己导入过，天然涵盖维护者——
// 后者=最早导入者）；② 有市场贡献记录（ChapterUpdateJob.claimedBy /
// ChapterVersion.authorId）——「给这本书干活，免费收藏」。
// 私有仓 / 未公开内容不收费；阅读本身永远免费（收费只卡个人书架收藏）。

import { prisma } from '@/lib/db';
import { CREDITS_CONFIG, getDynamicCreditsConfig } from '@/lib/credits-config';
import { CHAPTER_UPDATE_JOB_STATUS } from '@/lib/schemas/update-job';

/** 纯函数：书架费 = round(max(账本, 篇数保底) × 系数)；至少 1 积分（系数为 0 时免费） */
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

  // 全书物理规模保底（每 2 篇 1 积分）：防范未完工或接力仓局部少额账本击穿整仓身价
  const baseUnits = Math.max(safeLedger, safeDocCount > 0 ? Math.ceil(safeDocCount * 0.5) : 0);
  if (baseUnits > 0) {
    return Math.max(1, Math.round(baseUnits * safeMult));
  }
  return 0;
}

/**
 * 书架最终定价单一事实源：存在管理员显式覆盖价（shelfFeeOverride，0=免费）时优先采用，
 * 否则回落按劳动账本与文档保底规模的公式计算。
 */
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

/**
 * 豁免判定：导入者（含维护者）或本仓转录贡献者免收藏费。
 * 无法确认豁免资格时中止操作，不能把数据库故障解释为用户需要付费。
 */
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

/** 一次性开户礼金：原子增量入账，不覆盖余额，不重复生成流水。 */

export type ChargeShelfFeeResult =
  | { ok: true; fee: number; signupGift: number; alreadySaved: boolean; balance?: number }
  | { ok: false; code: 'INSUFFICIENT_BALANCE'; fee: number; balance: number };

/**
 * 收费并把公开教程加入书架（事务内原子完成）：
 * 已收藏 → 幂等返回；豁免/私有仓/费用 0 → 免费 upsert；
 * 否则锁 User 行校验余额 → 条件 decrement（gte 防负余额）→ 建行（记实付）；不发开户礼金。
 * 余额不足返回 INSUFFICIENT_BALANCE（事务回滚，不留书架行）。
 */
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
