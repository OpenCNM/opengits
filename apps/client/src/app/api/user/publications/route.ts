import { Prisma } from '@prisma/client';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { prisma } from '@/lib/db';
import { isAdminRole } from '@/lib/tiers';
import { deriveEditionLabel } from '@/lib/repository-resolver';
import { ENGINE_CONFIG } from '@/lib/config';

export const dynamic = 'force-dynamic';

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
  docUrl: string;
  createdAt: string;
  updatedAt: string;
}

export const GET = defineRoute({
  scope: 'GET /api/user/publications',
  auth: 'user',
  handler: async ({ userId }) => {
    // 1. 查询当前用户有贡献/导入/拥有的全部仓库 ID 与当前角色
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
      return ok({ publications: [] });
    }

    // 2. 并行获取仓库元数据、最早导入记录（维护者判定）、文档章节列表与接力任务
    const [repositories, earliestImports, allDocs, relayJobs] = await Promise.all([
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
      // 维护者判定下推 DB（性能修复 2026-10-13）：DISTINCT ON 每仓取最早一条
      // ImportRecord 的 userId——此前全量行拉回 JS 侧逐仓取首条，热门公共仓的
      // 导入记录随用户数线性膨胀
      prisma
        .$queryRaw<Array<{ repositoryId: string; userId: string }>>(
          Prisma.sql`
            SELECT DISTINCT ON ("repositoryId") "repositoryId", "userId"
            FROM "ImportRecord"
            WHERE "repositoryId" IN (${Prisma.join(repoIds)})
            ORDER BY "repositoryId", "createdAt" ASC, "id" ASC
          `
        )
        .catch(() => [] as Array<{ repositoryId: string; userId: string }>),
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
    ]);

    // 3. 构建接力参与者与进行中任务映射
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

    // 4. 构建维护者索引（最早 ImportRecord 用户即为维护者）
    const maintainerByRepoId = new Map<string, string>();
    for (const imp of earliestImports) {
      if (!maintainerByRepoId.has(imp.repositoryId)) {
        maintainerByRepoId.set(imp.repositoryId, imp.userId);
      }
    }

    // 5. 构建各仓库文档章节统计映射（用户私有文档优先覆盖共享文档）
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

    // 6. 投影各仓库发布管理视图对象
    const publications: UserPublicationItem[] = repositories.map((r) => {
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

      return {
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        branch: r.branch,
        edition: r.edition,
        editionLabel,
        isPublic: r.isPublic,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        reviewStatus: r.reviewStatus || 'NONE',
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
        docUrl,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });

    return ok({ publications });
  },
});
