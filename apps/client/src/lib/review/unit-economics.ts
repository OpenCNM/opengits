/**
 * 单位经济推导（Unit Economics）——纯函数，零物化。
 *
 * 输入全部为物理账本事实（Repository 计数列、CreditGrantLedger、
 * PendingCreditGrant、ChapterUpdateJob.actualCredits、Document 状态组、
 * SavedRepo 跟随），输出按仓聚合的成本/产出视图——运营回答
 * 「哪些教程值得继续烧 token」的数据依据。聚合在调用方（SQL groupBy）
 * 完成，本模块只做联结与派生指标，可单测。
 */

export interface UnitEconomicsRepoRow {
  id: string;
  owner: string;
  repo: string;
  edition: string;
  isPublic: boolean;
  views: number;
  publishedAt: Date | string | null;
  /** 累计转录 token 消耗（Repository.transcriptionTokens） */
  transcriptionTokens: number;
  /** 转录劳动账本累计（Repository.transcriptionCreditsEarned） */
  transcriptionCreditsEarned: number;
}

export interface LedgerSourceGroup {
  repositoryId: string;
  source: string;
  totalAmount: number;
}

export interface PendingStatusGroup {
  repositoryId: string;
  status: string;
  totalAmount: number;
}

export interface DocStatusCountGroup {
  repositoryId: string;
  status: string;
  count: number;
}

export interface FollowerCountGroup {
  repositoryId: string;
  count: number;
}

export interface UnitEconomicsEntry {
  id: string;
  label: string;
  edition: string;
  isPublic: boolean;
  views: number;
  chaptersTotal: number;
  chaptersProcessed: number;
  transcriptionTokens: number;
  transcriptionCreditsEarned: number;
  /** 按 source 分桶的已入账授予 */
  grantedBySource: Record<string, number>;
  grantedTotal: number;
  /** 待解冻（仍锁定中的贡献积分） */
  pendingLocked: number;
  /** 已解冻入账 */
  pendingUnlocked: number;
  /** 已作废（重发布可复活，非终态口径） */
  pendingCancelled: number;
  /** 接力市场实结积分（ChapterUpdateJob.actualCredits 累计） */
  relayActualCredits: number;
  followers: number;
  /** 效率指标：每消耗 1M token 带来的浏览量（0 token 仓为 null——无消耗即无效率语义） */
  viewsPerMillionTokens: number | null;
  /** 产出密度：每千次浏览对应的累计授予积分（0 浏览为 null） */
  creditsPerKiloViews: number | null;
}

export interface UnitEconomicsSummary {
  generatedAt: string;
  repoCount: number;
  totalTokens: number;
  totalGranted: number;
  totalPendingLocked: number;
  totalPendingUnlocked: number;
  totalRelayActualCredits: number;
  totalViews: number;
  /** 平台级效率：全量浏览 / 全量 token（1M 口径） */
  viewsPerMillionTokens: number | null;
}

export interface UnitEconomicsResult {
  summary: UnitEconomicsSummary;
  entries: UnitEconomicsEntry[];
}

export function deriveUnitEconomics(
  repos: readonly UnitEconomicsRepoRow[],
  ledgerGroups: readonly LedgerSourceGroup[],
  pendingGroups: readonly PendingStatusGroup[],
  docGroups: readonly DocStatusCountGroup[],
  followerGroups: readonly FollowerCountGroup[],
  relayGroups: readonly { repositoryId: string; totalActual: number }[]
): UnitEconomicsResult {
  const grantedMap = new Map<string, Record<string, number>>();
  for (const g of ledgerGroups) {
    const bucket = grantedMap.get(g.repositoryId) ?? {};
    bucket[g.source] = (bucket[g.source] ?? 0) + g.totalAmount;
    grantedMap.set(g.repositoryId, bucket);
  }

  const pendingMap = new Map<string, { locked: number; unlocked: number; cancelled: number }>();
  for (const g of pendingGroups) {
    const entry = pendingMap.get(g.repositoryId) ?? { locked: 0, unlocked: 0, cancelled: 0 };
    if (g.status === 'PENDING') entry.locked += g.totalAmount;
    else if (g.status === 'UNLOCKED') entry.unlocked += g.totalAmount;
    else if (g.status === 'CANCELLED') entry.cancelled += g.totalAmount;
    pendingMap.set(g.repositoryId, entry);
  }

  const docMap = new Map<string, { total: number; processed: number }>();
  for (const g of docGroups) {
    const entry = docMap.get(g.repositoryId) ?? { total: 0, processed: 0 };
    entry.total += g.count;
    if (g.status === 'PROCESSED') entry.processed += g.count;
    docMap.set(g.repositoryId, entry);
  }

  const followerMap = new Map<string, number>();
  for (const g of followerGroups) followerMap.set(g.repositoryId, g.count);

  const relayMap = new Map<string, number>();
  for (const g of relayGroups) relayMap.set(g.repositoryId, g.totalActual);

  const entries: UnitEconomicsEntry[] = repos.map((r) => {
    const grantedBySource = grantedMap.get(r.id) ?? {};
    const grantedTotal = Object.values(grantedBySource).reduce((a, b) => a + b, 0);
    const pending = pendingMap.get(r.id) ?? { locked: 0, unlocked: 0, cancelled: 0 };
    const docs = docMap.get(r.id) ?? { total: 0, processed: 0 };
    const relayActualCredits = relayMap.get(r.id) ?? 0;
    const grantedPlusRelay = grantedTotal + relayActualCredits;

    return {
      id: r.id,
      label: `${r.owner}/${r.repo}`,
      edition: r.edition,
      isPublic: r.isPublic,
      views: r.views,
      chaptersTotal: docs.total,
      chaptersProcessed: docs.processed,
      transcriptionTokens: r.transcriptionTokens,
      transcriptionCreditsEarned: r.transcriptionCreditsEarned,
      grantedBySource,
      grantedTotal,
      pendingLocked: pending.locked,
      pendingUnlocked: pending.unlocked,
      pendingCancelled: pending.cancelled,
      relayActualCredits,
      followers: followerMap.get(r.id) ?? 0,
      viewsPerMillionTokens:
        r.transcriptionTokens > 0 ? (r.views / r.transcriptionTokens) * 1_000_000 : null,
      creditsPerKiloViews: r.views > 0 ? (grantedPlusRelay / r.views) * 1_000 : null,
    };
  });

  const totalTokens = repos.reduce((a, r) => a + r.transcriptionTokens, 0);
  const totalViews = repos.reduce((a, r) => a + r.views, 0);
  const totalGranted = entries.reduce((a, e) => a + e.grantedTotal, 0);
  const totalPendingLocked = entries.reduce((a, e) => a + e.pendingLocked, 0);
  const totalPendingUnlocked = entries.reduce((a, e) => a + e.pendingUnlocked, 0);
  const totalRelayActualCredits = entries.reduce((a, e) => a + e.relayActualCredits, 0);

  return {
    summary: {
      generatedAt: new Date().toISOString(),
      repoCount: repos.length,
      totalTokens,
      totalGranted,
      totalPendingLocked,
      totalPendingUnlocked,
      totalRelayActualCredits,
      totalViews,
      viewsPerMillionTokens: totalTokens > 0 ? (totalViews / totalTokens) * 1_000_000 : null,
    },
    entries,
  };
}
