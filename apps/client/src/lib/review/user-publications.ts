import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isAdminRole } from '@/lib/tiers';
import { deriveEditionLabel } from '@/lib/repository-resolver';
import { ENGINE_CONFIG } from '@/lib/config';

export interface RelayParticipant {
  userId: string;
  name: string | null;
  image: string | null;
  active: boolean;
}

export interface UserPublicationItem {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  edition: string;
  editionLabel: string | null;
  isPublic: boolean;
  publishedAt: string | null;
  reviewStatus: string;
  rejectionReason: string | null;
  transcriptionCreditsEarned: number;
  relayEnabled: boolean;
  relayInProgressCount: number;
  relayParticipants: RelayParticipant[];
  chapterCount: number;
  processedDocsCount: number;
  unprocessedCount: number;
  isMaintainer: boolean;
  unpublishCooldownUntil: string | null;
  unpublishRequestedAt: string | null;
  hasExternalUsers: boolean;
  canDelete: boolean;
  docUrl: string;
  createdAt: string;
  updatedAt: string;
}

export async function listUserPublications(userId: string): Promise<UserPublicationItem[]> {
  const [userImports, userDocs, userRecord] = await Promise.all([
    prisma.importRecord.findMany({
      where: { userId },
      select: { repositoryId: true },
    }),
    prisma.document.findMany({
      where: { ownerUserId: userId },
      select: { repositoryId: true },
      distinct: ['repositoryId'],
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    }),
  ]);

  const isAdmin = isAdminRole(userRecord?.role);

  const repoIds = Array.from(
    new Set([
      ...userImports.map((i) => i.repositoryId),
      ...userDocs.map((d) => d.repositoryId),
    ])
  );

  if (repoIds.length === 0) {
    return [];
  }

  const [repositories, earliestImports, allDocs, relayJobs, externalHolders] = await Promise.all([
    prisma.repository.findMany({
      where: { id: { in: repoIds } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        owner: true,
        repo: true,
        branch: true,
        edition: true,
        isPublic: true,
        publishedAt: true,
        reviewStatus: true,
        rejectionReason: true,
        transcriptionCreditsEarned: true,
        relayEnabled: true,
        repoProfile: true,
        unpublishCooldownUntil: true,
        unpublishRequestedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    // DISTINCT ON resolves earliest ImportRecord per repo in DB to avoid loading full import histories.
    prisma.$queryRaw<Array<{ repositoryId: string; userId: string }>>(
      Prisma.sql`
        SELECT DISTINCT ON ("repositoryId") "repositoryId", "userId"
        FROM "ImportRecord"
        WHERE "repositoryId" IN (${Prisma.join(repoIds)})
        ORDER BY "repositoryId", "createdAt" ASC, "id" ASC
      `
    ),
    prisma.document.findMany({
      where: {
        repositoryId: { in: repoIds },
        OR: [{ ownerUserId: null }, { ownerUserId: userId }],
      },
      select: {
        repositoryId: true,
        path: true,
        status: true,
        ownerUserId: true,
      },
    }),
    prisma.chapterUpdateJob.findMany({
      where: {
        repositoryId: { in: repoIds },
        status: { in: ['CLAIMED', 'TRIAL', 'SWAPPED'] },
      },
      select: {
        repositoryId: true,
        status: true,
        claimedBy: true,
      },
    }),
    prisma.$queryRaw<Array<{ repositoryId: string }>>(
      Prisma.sql`
        SELECT "repositoryId" FROM "SavedRepo"
        WHERE "repositoryId" IN (${Prisma.join(repoIds)}) AND "userId" <> ${userId}
        UNION
        SELECT "repositoryId" FROM "Document"
        WHERE "repositoryId" IN (${Prisma.join(repoIds)}) AND "ownerUserId" IS NOT NULL AND "ownerUserId" <> ${userId}
        UNION
        SELECT "repositoryId" FROM "ImportRecord"
        WHERE "repositoryId" IN (${Prisma.join(repoIds)}) AND "userId" <> ${userId}
        UNION
        SELECT "repositoryId" FROM "ChapterVersion"
        WHERE "repositoryId" IN (${Prisma.join(repoIds)}) AND "authorId" <> ${userId}
      `
    ),
  ]);

  const externalHolderRepoIds = new Set(externalHolders.map((row) => row.repositoryId));

  const claimedUserIds = Array.from(
    new Set(relayJobs.map((j) => j.claimedBy).filter((v): v is string => Boolean(v)))
  );
  const relayUsers = claimedUserIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: claimedUserIds } },
        select: { id: true, name: true, image: true },
      })
    : [];
  const relayUserMap = new Map(relayUsers.map((u) => [u.id, u]));

  const relayByRepo = new Map<string, { inProgress: number; participants: RelayParticipant[] }>();
  for (const job of relayJobs) {
    const user = job.claimedBy ? relayUserMap.get(job.claimedBy) : undefined;
    if (!user) continue;
    let summary = relayByRepo.get(job.repositoryId);
    if (!summary) {
      summary = { inProgress: 0, participants: [] };
      relayByRepo.set(job.repositoryId, summary);
    }
    const isUnswapped = job.status !== 'SWAPPED';
    if (isUnswapped) {
      summary.inProgress++;
    }
    let participant = summary.participants.find((p) => p.userId === user.id);
    if (!participant) {
      participant = {
        userId: user.id,
        name: user.name,
        image: user.image,
        active: isUnswapped,
      };
      summary.participants.push(participant);
    } else if (isUnswapped) {
      participant.active = true;
    }
  }
  for (const summary of relayByRepo.values()) {
    summary.participants.sort((a, b) => Number(b.active) - Number(a.active));
  }

  const maintainerByRepoId = new Map<string, string>();
  for (const imp of earliestImports) {
    if (!maintainerByRepoId.has(imp.repositoryId)) {
      maintainerByRepoId.set(imp.repositoryId, imp.userId);
    }
  }

  const docsByRepo = new Map<string, Map<string, string>>();
  for (const doc of allDocs) {
    let repoMap = docsByRepo.get(doc.repositoryId);
    if (!repoMap) {
      repoMap = new Map();
      docsByRepo.set(doc.repositoryId, repoMap);
    }
    if (!repoMap.has(doc.path) || doc.ownerUserId === userId) {
      repoMap.set(doc.path, doc.status);
    }
  }

  return repositories.map((r) => {
    const repoDocMap = docsByRepo.get(r.id) || new Map();
    const chapterCount = repoDocMap.size;
    let processedDocsCount = 0;
    for (const status of repoDocMap.values()) {
      if (status === 'PROCESSED') {
        processedDocsCount++;
      }
    }
    const unprocessedCount = Math.max(0, chapterCount - processedDocsCount);
    const isMaintainer = isAdmin || maintainerByRepoId.get(r.id) === userId;

    const profile = (r.repoProfile as Record<string, any> | null) ?? null;
    let editionLabel: string | null = null;
    if (typeof profile?.editionLabel === 'string' && profile.editionLabel.trim() !== '') {
      editionLabel = profile.editionLabel.trim();
    } else if (r.edition && r.edition !== '') {
      editionLabel = deriveEditionLabel(r.repoProfile);
    }

    const params = new URLSearchParams();
    if (r.edition) params.set('edition', r.edition);
    if (r.branch && r.branch !== ENGINE_CONFIG.defaultBranch && r.branch !== 'master') params.set('branch', r.branch);
    const queryStr = params.toString();
    const docUrl = `/docs/${r.owner}/${r.repo}${queryStr ? `?${queryStr}` : ''}`;

    const relaySummary = relayByRepo.get(r.id) ?? { inProgress: 0, participants: [] };
    const reviewStatus = r.reviewStatus || 'NONE';
    const hasExternalUsers = externalHolderRepoIds.has(r.id);
    const canDelete = !r.isPublic && reviewStatus !== 'PENDING' && isMaintainer && !hasExternalUsers;

    return {
      id: r.id,
      owner: r.owner,
      repo: r.repo,
      branch: r.branch,
      edition: r.edition,
      editionLabel,
      isPublic: r.isPublic,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      reviewStatus,
      rejectionReason: r.rejectionReason,
      transcriptionCreditsEarned: r.transcriptionCreditsEarned,
      relayEnabled: r.relayEnabled,
      relayInProgressCount: relaySummary.inProgress,
      relayParticipants: relaySummary.participants,
      chapterCount,
      processedDocsCount,
      unprocessedCount,
      isMaintainer,
      unpublishCooldownUntil: r.unpublishCooldownUntil ? r.unpublishCooldownUntil.toISOString() : null,
      unpublishRequestedAt: r.unpublishRequestedAt ? r.unpublishRequestedAt.toISOString() : null,
      hasExternalUsers,
      canDelete,
      docUrl,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}
