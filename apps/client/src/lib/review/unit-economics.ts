export interface UnitEconomicsRepoRow {
  id: string;
  owner: string;
  repo: string;
  edition: string;
  isPublic: boolean;
  views: number;
  publishedAt: Date | string | null;
  transcriptionTokens: number;
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
  grantedBySource: Record<string, number>;
  grantedTotal: number;
  pendingLocked: number;
  pendingUnlocked: number;
  pendingCancelled: number;
  relayActualCredits: number;
  followers: number;
  // Return null on zero denominator to distinguish missing usage from zero efficiency.
  viewsPerMillionTokens: number | null;
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
