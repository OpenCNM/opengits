import { cookies } from 'next/headers';
import { getSessionHelper } from '@/lib/auth-helper';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { STORAGE_KEYS, SYSTEM_BATCH_TRANSCRIBER_USER_ID } from '@/lib/constants';
import { computeProgressBatchCached } from '@/lib/reading-fingerprint-adapter';
import { getPublicHomeData, normalizeHomeSort } from '@/lib/home/public-home-data';
import { GitHubHomeView } from '@/components/home/GitHubHomeView';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sort?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const session = await getSessionHelper();
  const userId = session?.user?.id || null;

  const activeTab = resolvedSearchParams.tab === 'public' || !userId
    ? 'public'
    : resolvedSearchParams.tab === 'review'
    ? 'review'
    : 'my-shelf';

  const sort = normalizeHomeSort(resolvedSearchParams.sort);

  // ── 公共数据层（unstable_cache）：匿名访客整页命中；
  const publicData = (await getPublicHomeData(resolvedSearchParams.sort)) || ({} as any);
  const publicRepos = publicData.publicRepos || [];
  const docsByRepoBaseline = publicData.docsByRepoBaseline || {};
  const publicRecScores = publicData.recScores || {};
  const mcpHealthByRepo = publicData.mcpHealthByRepo || {};
  const relayByRepo = publicData.relayByRepo || {};
  const publicShelfFees = publicData.shelfFees || {};
  const chapterCountsByRepo: Record<string, number> = {
    ...(publicData.chapterCountsByRepo || {}),
  };

  const includeDocs = {
    documents: {
      select: { path: true },
      where: {
        OR: [
          { path: { contains: 'zh' } },
          { path: { contains: 'en' } },
          { path: { contains: 'ja' } }
        ]
      },
      take: ENGINE_CONFIG.pagination.homeReposLimit
    }
  };

  let myRepos: any[] = [];
  let hasPreferencesSet = false;
  let pinnedRepoIds = new Set<string>();
  let disabledMcpRepoIds = new Set<string>();
  let savedRepoIds = new Set<string>();
  let autoFollowByRepoId = new Map<string, boolean>();
  let swappedJobs: Array<{ repositoryId: string }> = [];

  if (userId) {
    const userWithRepos = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        savedRepos: {
          include: {
            repository: {
              include: {
                ...includeDocs,
                _count: {
                  select: {
                    savedRepos: {
                      where: {
                        userId: { not: SYSTEM_BATCH_TRANSCRIBER_USER_ID },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    let savedRows = userWithRepos?.savedRepos || [];

    // 🌟 第一性原理：接力贡献者物理对齐——参与过接力转录（SWAPPED）的教程，物理事实即属于个人项目
    // 自动补齐因历史遗漏未建的 SavedRepo，实现书架数据自愈与幂等收敛。
    // SWAPPED 超集一次查询（原先同请求跑两次：带 notIn 的自愈查询 + 不带的豁免清单查询，
    // 后者为前者超集）——自愈子集在内存用 currentSavedIdSet 过滤导出，语义等价
    const currentSavedIdSet = new Set(savedRows.map((sr) => sr.repository.id));
    swappedJobs = await prisma.chapterUpdateJob.findMany({
      where: { claimedBy: userId, status: 'SWAPPED' },
      select: { repositoryId: true },
      distinct: ['repositoryId'],
    });
    const contributedJobs = swappedJobs.filter((j) => !currentSavedIdSet.has(j.repositoryId));

    if (contributedJobs.length > 0) {
      const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');
      for (const cj of contributedJobs) {
        await chargeShelfFeeAndSave(userId, cj.repositoryId, true).catch(() => null);
      }
      const refetchedUser = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          savedRepos: {
            include: {
              repository: {
                include: {
                  ...includeDocs,
                  _count: {
                    select: {
                      savedRepos: {
                        where: {
                          userId: { not: SYSTEM_BATCH_TRANSCRIBER_USER_ID },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      savedRows = refetchedUser?.savedRepos || savedRows;
    }

    // 🌟 第一性原理：导入所有者物理对齐——用户本人导入过的仓库（ImportRecord），物理事实即归属个人项目
    const userImportedRows = await prisma.importRecord.findMany({
      where: { userId },
      select: {
        repository: {
          include: {
            ...includeDocs,
            _count: {
              select: {
                savedRepos: {
                  where: {
                    userId: { not: SYSTEM_BATCH_TRANSCRIBER_USER_ID },
                  },
                },
              },
            },
          },
        },
      },
    });
    const currentSavedRepoIdSet = new Set(savedRows.map((sr) => sr.repository.id));
    for (const ir of userImportedRows) {
      if (ir.repository && !currentSavedRepoIdSet.has(ir.repository.id)) {
        savedRows.push({ repository: ir.repository, autoFollow: true } as any);
        currentSavedRepoIdSet.add(ir.repository.id);
      }
    }

    myRepos = savedRows.map((sr) => sr.repository);
    hasPreferencesSet = Boolean(userWithRepos?.hasPreferencesSet);
    autoFollowByRepoId = new Map(savedRows.map((sr) => [sr.repository.id, sr.autoFollow]));
    pinnedRepoIds = new Set(userWithRepos?.pinnedRepoIds || []);
    disabledMcpRepoIds = new Set(userWithRepos?.disabledMcpRepoIds || []);
    savedRepoIds = new Set(myRepos.map((r) => r.id));
  }

  // 贡献者豁免清单（已完工接力贡献者入架展示价 0 积分）——直接复用上方 SWAPPED 超集
  const exemptRepoIds = new Set(swappedJobs.map((j) => j.repositoryId));

  const allRepoIds = Array.from(
    new Set([...publicRepos.map((r) => r.id), ...myRepos.map((r) => r.id)])
  );

  const importRecordsMap: Record<string, string> = {};
  const userImportedRepoIdSet = new Set<string>();
  if (userId && allRepoIds.length > 0) {
    const records = await prisma.importRecord.findMany({
      where: { userId, repositoryId: { in: allRepoIds } },
      select: { repositoryId: true, sha: true },
    });
    records.forEach((r) => {
      importRecordsMap[r.repositoryId] = r.sha;
      userImportedRepoIdSet.add(r.repositoryId);
    });
  }

  // 文档投影：公共仓复用缓存基线，登录用户叠加个人文档与书架仓文档
  const docsByRepo: Record<string, { path: string; status: string }[]> = {};
  for (const [rid, list] of Object.entries(docsByRepoBaseline)) {
    docsByRepo[rid] = list.map((d) => ({ ...d }));
  }

  if (userId && allRepoIds.length > 0) {
    const missingDocsRepoIds = allRepoIds.filter((id) => !docsByRepo[id]);
    if (missingDocsRepoIds.length > 0) {
      // 对缺失的仓同样遵循大纲即作用域（Outline As Scope）原则
      const missingOutlines = await prisma.tutorialOutline.findMany({
        where: { repositoryId: { in: missingDocsRepoIds }, isActive: true },
        select: {
          repositoryId: true,
          chapters: {
            orderBy: { teachingOrder: 'asc' },
            select: {
              id: true,
              nodes: {
                orderBy: { teachingOrder: 'asc' },
                select: {
                  documentId: true,
                  headingPath: true,
                  document: { select: { id: true, path: true, status: true } },
                },
              },
            },
          },
        },
      });
      const missingOutlineRepoIdSet = new Set(missingOutlines.map((o) => o.repositoryId));
      for (const outline of missingOutlines) {
        chapterCountsByRepo[outline.repositoryId] = outline.chapters.length;
        const list: Array<{ path: string; status: string }> = [];
        for (const ch of outline.chapters) {
          for (const n of ch.nodes) {
            if (n.document && n.document.path) {
              list.push({ path: n.document.path, status: n.document.status || 'PROCESSED' });
            } else {
              list.push({ path: n.headingPath || `node-${n.documentId || ch.id}`, status: 'UNPROCESSED' });
            }
          }
        }
        docsByRepo[outline.repositoryId] = list;
      }
      const pureFallbackRepoIds = missingDocsRepoIds.filter((id) => !missingOutlineRepoIdSet.has(id));
      if (pureFallbackRepoIds.length > 0) {
        const fallbackDocs = await prisma.document.findMany({
          where: { repositoryId: { in: pureFallbackRepoIds }, ownerUserId: null },
          select: { repositoryId: true, path: true, status: true },
        });
        fallbackDocs.forEach((d) => {
          if (!d || !d.repositoryId || !d.path) return;
          (docsByRepo[d.repositoryId] ??= []).push({
            path: d.path,
            status: d.status || 'PROCESSED',
          });
        });
      }
    }

    // 叠加登录用户自己的专属私有文档（ownerUserId=userId）
    const userPrivateDocs = await prisma.document.findMany({
      where: { repositoryId: { in: allRepoIds }, ownerUserId: userId },
      select: { repositoryId: true, path: true, status: true },
    });
    userPrivateDocs.forEach((d) => {
      if (!d || !d.repositoryId || !d.path) return;
      (docsByRepo[d.repositoryId] ??= []).push({
        path: d.path,
        status: d.status || 'PROCESSED',
      });
    });
  }

  // Compute reading fingerprint progress for all repos in batch
  const allReposCombined = [
    ...publicRepos,
    ...myRepos.filter((mr) => !publicRepos.some((pr) => pr.id === mr.id)),
  ];

  const progressMap = userId
    ? await computeProgressBatchCached(
        userId,
        allReposCombined.map((repo: any) => ({
          id: repo.id,
          owner: repo.owner || '',
          repo: repo.repo || '',
          edition: repo.edition || '',
          createdAt: repo.createdAt,
          docs: (docsByRepo[repo?.id] || []).map((d: { path: string }) => ({
            path: typeof d === 'string' ? d : d.path,
          })),
        }))
      )
    : {};

  const formatDisplayRepo = (repo: any) => {
    const repoDocs = docsByRepo[repo?.id] || [];
    let processedCount = 0;
    repoDocs.forEach((docObj) => {
      const status = typeof docObj === 'string' ? 'PROCESSED' : docObj.status;
      if (status === 'PROCESSED') processedCount++;
    });

    const totalDocs = repoDocs.length;
    const effectiveChapterCount = chapterCountsByRepo[repo?.id] ?? totalDocs;
    const fpResult = progressMap[repo?.id];
    const progress = fpResult?.progress ?? 0;
    const viewedCount = fpResult?.viewedCount ?? 0;
    const importedSha = importRecordsMap[repo?.id] || null;
    const hasUpdate = Boolean(repo?.gitSha && importedSha && repo.gitSha !== importedSha);
    const isPinned = pinnedRepoIds.has(repo?.id);
    const isFullyTranscribed = totalDocs > 0 ? processedCount >= totalDocs : true;

    const profile = (repo?.repoProfile && typeof repo.repoProfile === 'object' ? repo.repoProfile : {}) as Record<string, any>;
    const profileDescriptionZh = typeof profile.descriptionZh === 'string' && profile.descriptionZh.trim()
      ? profile.descriptionZh.trim()
      : '';
    const profileDescriptionEn = typeof profile.descriptionEn === 'string' && profile.descriptionEn.trim()
      ? profile.descriptionEn.trim()
      : '';
    const profileDescription = typeof profile.description === 'string' && profile.description.trim()
      ? profile.description.trim()
      : typeof profile.summary === 'string' && profile.summary.trim()
      ? profile.summary.trim()
      : '';

    return {
      ...repo,
      description: (repo?.description && repo.description.trim()) || profileDescription || profileDescriptionZh || profileDescriptionEn,
      ...(profileDescriptionZh ? { descriptionZh: profileDescriptionZh } : {}),
      ...(profileDescriptionEn ? { descriptionEn: profileDescriptionEn } : {}),
      transcriptionTokens: repo?.transcriptionTokens || 0,
      documents: repoDocs.map((p: any) => ({ path: typeof p === 'string' ? p : p.path })),
      chapterCount: effectiveChapterCount,
      processedDocsCount: processedCount,
      isFullyTranscribed,
      isSaved: savedRepoIds.has(repo?.id),
      savedCount: repo?._count?.savedRepos ?? 0,
      progress,
      viewedCount,
      hasUpdate,
      importedSha,
      isPinned,
      autoFollow: autoFollowByRepoId.get(repo?.id) ?? undefined,
      isMcpDisabled: disabledMcpRepoIds.has(repo?.id),
      recScore: publicRecScores?.[repo?.id] ?? 0,
      // 书架费展示价（收费透明化）：豁免贡献者恒为 0；其余以公共定价为准
      shelfFeeEstimate: exemptRepoIds.has(repo?.id) ? 0 : (publicShelfFees?.[repo?.id] ?? 0),
      // 巨仓社区接力：进度 + 参与者（公共列表缓存聚合；仅在存在待开荒章节时向卡片挂载接力入口）
      ...(repo?.relayEnabled && totalDocs > 0 && processedCount < totalDocs
        ? {
            relay: {
              done: processedCount,
              total: totalDocs,
              inProgress: relayByRepo?.[repo?.id]?.inProgress ?? 0,
              participants: relayByRepo?.[repo?.id]?.participants ?? [],
            },
          }
        : {}),
      lastReadPath:
        fpResult?.lastReadPath ||
        (repoDocs[0]
          ? typeof repoDocs[0] === 'string'
            ? repoDocs[0]
            : repoDocs[0].path
          : null),
      lastReadAt: fpResult?.lastReadAt || null,
    };
  };

  // ── 讲法分组：同一仓库的多讲法行聚合为一张卡
  const { buildRepoEditionGroups, sameSourceEditionGroupKey } = await import('@/lib/edition');
  const { deriveEditionLabel } = await import('@/lib/repository-resolver');
  const { computeRecommendationScore, mergeMcpHealth } = await import('@/lib/recommendation/score');

  const groupEditions = (reposList: any[]) => {
    const editionGroups = buildRepoEditionGroups(reposList, {
      groupKey: sameSourceEditionGroupKey,
    });
    return editionGroups.map((group) => {
      if (group.editionCount === 1) {
        return group.primary;
      }
      const primaryOwnerRepo = `${(group.primary.owner || '').toLowerCase()}/${(group.primary.repo || '').toLowerCase()}`;
      const toChip = (row: any) => {
        const editionKey = row.edition ?? '';
        const profile = (row.repoProfile ?? {}) as Record<string, unknown>;
        const isGroupMaintainer = Boolean(
          userId &&
            group.all.some(
              (r: any) => userImportedRepoIdSet.has(r.id) || importRecordsMap[r.id] || r.isMaintainer
            )
        );

        return {
          id: row.id,
          edition: editionKey,
          label: deriveEditionLabel(row.repoProfile, row.transcriptionModels),
          presetId:
            typeof profile.editionPreset === 'string'
              ? profile.editionPreset
              : typeof profile.transcriptionPreset === 'string'
              ? profile.transcriptionPreset
              : null,
          isDefault: editionKey === '',
          isSaved: savedRepoIds.has(row.id),
          progress: row.progress ?? 0,
          lastReadPath: row.lastReadPath ?? null,
          lastReadAt: row.lastReadAt ?? null,
          chapterCount: row.chapterCount ?? 0,
          processedDocsCount: row.processedDocsCount ?? 0,
          shelfFeeEstimate: exemptRepoIds.has(row.id) ? 0 : (row.shelfFeeEstimate ?? 0),
          docUrl: `/docs/${row.owner}/${row.repo}${editionKey ? `?edition=${encodeURIComponent(editionKey)}` : ''}`,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          transcriptionModels: row.transcriptionModels || [],
          transcriptionTokens: row.transcriptionTokens || 0,
          fingerprint:
            typeof profile.editionFingerprint === 'string'
              ? profile.editionFingerprint
              : undefined,
          isSameSource:
            `${(row.owner || '').toLowerCase()}/${(row.repo || '').toLowerCase()}` !==
            primaryOwnerRepo,
          branch: row.branch || ENGINE_CONFIG.defaultBranch,
          gitSha: row.gitSha || row.importedSha || null,
          hasUpdate: Boolean(row.hasUpdate),
          importedSha: row.importedSha || null,
          isMaintainer: isGroupMaintainer || Boolean(userId && (userImportedRepoIdSet.has(row.id) || importRecordsMap[row.id] || row.isMaintainer)),
          canManage: isGroupMaintainer || Boolean(userId && (userImportedRepoIdSet.has(row.id) || importRecordsMap[row.id] || row.isMaintainer)),
          isPublic: Boolean(row.isPublic),
          relayEnabled: Boolean(row.relayEnabled),
          isFullyTranscribed: Boolean(row.isFullyTranscribed),
          relay: row.relay ?? null,
          reviewPipeline: row.reviewPipeline ?? null,
          reviewLlm: row.reviewLlm ?? null,
          reviewAppealsRemaining: typeof (row.repoProfile as any)?.reviewAppealsRemaining === 'number' ? (row.repoProfile as any).reviewAppealsRemaining : 3,
          savedCount: typeof row.savedCount === 'number' ? row.savedCount : (row._count?.savedRepos ?? 0),
          helpfulCount: row.helpfulCount ?? 0,
        };
      };

      const baseRows = group.all.filter((r: any) => (r.edition ?? '') === '');
      const restRows = group.all
        .filter((r: any) => (r.edition ?? '') !== '')
        .sort((a: any, b: any) => {
          const helpfulDiff = (b.helpfulCount ?? 0) - (a.helpfulCount ?? 0);
          if (helpfulDiff !== 0) return helpfulDiff;
          const reviewDiff =
            ((b.reviewPipeline as any)?.total ?? 0) - ((a.reviewPipeline as any)?.total ?? 0);
          if (reviewDiff !== 0) return reviewDiff;
          const completionA =
            (a.chapterCount ?? 0) > 0 ? (a.processedDocsCount ?? 0) / a.chapterCount : 0;
          const completionB =
            (b.chapterCount ?? 0) > 0 ? (b.processedDocsCount ?? 0) / b.chapterCount : 0;
          if (completionA !== completionB) return completionB - completionA;
          return String(a.edition ?? '').localeCompare(String(b.edition ?? ''));
        });

      const totalSavedCount = group.all.reduce((sum, r) => sum + (r.savedCount ?? 0), 0);
      const totalViews = group.all.reduce((sum, r) => sum + (r.views ?? 0), 0);
      const totalMcpCallCount = group.all.reduce((sum, r) => sum + (r.mcpCallCount ?? 0), 0);
      const totalHelpfulCount = group.all.reduce((sum, r) => sum + (r.helpfulCount ?? 0), 0);

      // 聚合全组所有版本的大模型与总消耗 Token
      const allTranscriptionModels = Array.from(
        new Set(
          group.all
            .flatMap((r: any) => r.transcriptionModels || [])
            .filter((m: any): m is string => typeof m === 'string' && m.trim().length > 0)
        )
      );
      const totalTranscriptionTokens = group.all.reduce(
        (sum: number, r: any) => sum + (r.transcriptionTokens || 0),
        0
      );

      // BUG-04 修复：使用全组累加后的真实热度指标重算主卡 recScore，让热榜排序能体现全仓综合认可度；
      // MCP 健康同口径合并（近期调用求和 + 盲区率按调用数加权），与单讲法卡分量一致
      const llmJson = group.primary.reviewLlm as Record<string, unknown> | null | undefined;
      const rawLlm = llmJson?.unavailable ? null : (llmJson?.overallScore as number | null | undefined);
      const normLlm = rawLlm != null ? (rawLlm <= 10 && rawLlm > 0 ? Math.round(rawLlm * 10) : rawLlm) : null;
      const aggregatedRecScore = computeRecommendationScore(
        {
          savedCount: totalSavedCount,
          helpfulCount: totalHelpfulCount,
          mcpCallCount: totalMcpCallCount,
          updatedAt: group.primary.updatedAt ?? new Date(0),
          reviewPipelineTotal: (group.primary.reviewPipeline as Record<string, unknown> | null)?.total as number | null ?? null,
          reviewLlmScore: normLlm,
        },
        mergeMcpHealth(group.all.map((r: any) => mcpHealthByRepo[r?.id])),
      ).total;

      // 聚合活跃阅读讲法：若该讲法组中有任意版本产生过真实阅读，让主卡聚合活跃版本的阅读状态
      const activeReadEdition = [...group.all]
        .filter((r: any) => Boolean(r.lastReadAt || (r.progress || 0) > 0))
        .sort((a: any, b: any) => {
          const ta = a.lastReadAt ? new Date(a.lastReadAt).getTime() : 0;
          const tb = b.lastReadAt ? new Date(b.lastReadAt).getTime() : 0;
          if (tb !== ta) return tb - ta;
          return (b.progress || 0) - (a.progress || 0);
        })[0];

      const isAnySaved = group.all.some((r: any) => savedRepoIds.has(r.id));
      return {
        ...group.primary,
        savedCount: totalSavedCount,
        views: totalViews,
        helpfulCount: totalHelpfulCount,
        mcpCallCount: totalMcpCallCount,
        transcriptionModels: allTranscriptionModels.length > 0 ? allTranscriptionModels : (group.primary.transcriptionModels || []),
        transcriptionTokens: totalTranscriptionTokens > 0 ? totalTranscriptionTokens : (group.primary.transcriptionTokens || 0),
        recScore: aggregatedRecScore,
        isSaved: isAnySaved || group.primary.isSaved,
        ...(activeReadEdition
          ? {
              progress: activeReadEdition.progress ?? 0,
              lastReadPath: activeReadEdition.lastReadPath ?? group.primary.lastReadPath,
              lastReadAt: activeReadEdition.lastReadAt ?? null,
              edition: activeReadEdition.edition ?? group.primary.edition,
              chapterCount: activeReadEdition.chapterCount ?? group.primary.chapterCount,
              processedDocsCount: activeReadEdition.processedDocsCount ?? group.primary.processedDocsCount,
              isFullyTranscribed: Boolean(activeReadEdition.isFullyTranscribed),
              relayEnabled: Boolean(activeReadEdition.relayEnabled),
              relay: activeReadEdition.relay ?? undefined,
            }
          : {}),
        editionGroup: { editions: [...baseRows, ...restRows].map(toChip) },
      };
    });
  };

  const sortRepos = (reposList: any[]) => {
    return [...reposList].sort((a, b) => {
      switch (sort) {
        case 'hot':
          const recA = a.recScore || 0;
          const recB = b.recScore || 0;
          if (recA !== recB) return recB - recA;
          const scoreA = a.views || 0;
          const scoreB = b.views || 0;
          if (scoreA !== scoreB) return scoreB - scoreA;
          const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
        case 'newest': {
          const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
        }
        case 'oldest': {
          const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return (isNaN(timeA) ? 0 : timeA) - (isNaN(timeB) ? 0 : timeB);
        }
        case 'az':
          return String(a.repo || '').localeCompare(String(b.repo || ''));
        case 'za':
          return String(b.repo || '').localeCompare(String(a.repo || ''));
        default:
          return 0;
      }
    });
  };

  const publicRepoIdSet = new Set(publicRepos.map((r) => r.id));
  const myRepoIdSet = new Set(myRepos.map((r) => r.id));

  // 讲法分组统一收敛：将公共仓与登录用户自有/书架仓统一输入分组引擎，
  // 保证同一仓库下无论公共基础行还是用户专属衍生版本，均能聚合成完整的多版本讲法矩阵
  const allGroupedRepos = groupEditions(allReposCombined.map(formatDisplayRepo));

  // 公共广场卡片：属于公共仓集合（或主行公开）的讲法组，按排序规则输出
  const displayPublicRepos = sortRepos(
    allGroupedRepos.filter((group) =>
      group.isPublic || (group.editionGroup?.editions?.some((e: any) => e.isPublic) ?? false) || publicRepoIdSet.has(group.id)
    )
  );

  // 我的项目卡片：组内包含用户书架或导入仓的讲法组，按置顶与更新状态输出
  const displayMyRepos = allGroupedRepos
    .filter((group) => {
      if (myRepoIdSet.has(group.id)) return true;
      const chipIds = group.editionGroup?.editions?.map((e: any) => e.id) || [];
      return chipIds.some((id: string) => myRepoIdSet.has(id));
    })
    .sort((a, b) => {
      const aPinned = a.isPinned || (a.editionGroup?.editions?.some((e: any) => pinnedRepoIds.has(e.id)) ?? false);
      const bPinned = b.isPinned || (b.editionGroup?.editions?.some((e: any) => pinnedRepoIds.has(e.id)) ?? false);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return 0;
    });

  // 全站公告横幅：查询生效中且已上线的 announcement，并通过 cookie 过滤已关闭的公告，确保 SSR 首帧与客户端 100% 一致（消除刷新闪烁）
  let announcements: any[] = [];
  try {
    const cookieStore = await cookies();
    const rawClosed = cookieStore.get(STORAGE_KEYS.CLOSED_ANNOUNCEMENTS)?.value;
    let closedIds: string[] = [];
    if (rawClosed) {
      try {
        closedIds = JSON.parse(decodeURIComponent(rawClosed));
      } catch {
        closedIds = [];
      }
    }

    const now = new Date();
    const rows = await prisma.platformPromotion.findMany({
      where: {
        kind: 'announcement',
        isPinned: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      take: 3,
    });
    announcements = rows
      .filter((r) => !closedIds.includes(r.id))
      .map((r) => ({
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        targetUrl: r.targetUrl,
        badge: r.badge,
        dismissible: r.dismissible,
      }));
  } catch { /* ignore */ }

  return (
    <GitHubHomeView
      initialRepos={displayPublicRepos}
      initialMyRepos={displayMyRepos}
      userId={userId}
      hasPreferencesSet={hasPreferencesSet}
      activeTab={activeTab}
      sort={sort}
      announcements={announcements}
    />
  );
}
