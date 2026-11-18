import { unstable_cache } from 'next/cache';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { SYSTEM_BATCH_TRANSCRIBER_USER_ID } from '@/lib/constants';
import type { McpHealth } from '@/lib/recommendation/score';

/**
 * ─────────────────────────────────────────────────────────────
 * 首页公共数据层（SCALING_ROADMAP P-01）：
 * 把"无会话依赖的公共部分"包进 unstable_cache——
 * - publicRepos：公开仓列表（take 上限 + 复合索引，UI 行为零变化）；
 * - docsByRepoBaseline：基线文档投影（ownerUserId=null，匿名可见口径）；
 * - recScores：推荐分（内容派生：社区信号 + MCP 健康 + 审核基线 + 新鲜度）。
 *
 * 匿名访客整页命中缓存；登录用户仅个性化段（isSaved/书架/进度指纹/钉选）每请求计算。
 * 失效：导入完成/发布/下架时 revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max')（stale-while-revalidate），
 * 另有 homeCacheTtlSeconds 兜底过期。>homeMaxRepos 的长尾仓需走搜索/分类入口（文档已说明）。
 * ─────────────────────────────────────────────────────────────
 */

export const PUBLIC_HOME_CACHE_TAG = 'home:v2';

export type HomeSortKey = 'hot' | 'newest' | 'oldest' | 'az' | 'za';

/** 排序参数归一化：非法值一律回落 hot（与原 page.tsx 内联逻辑一致） */
export function normalizeHomeSort(input?: string | null): HomeSortKey {
  return input === 'newest' || input === 'oldest' || input === 'az' || input === 'za'
    ? input
    : 'hot';
}

const LANG_DOC_INCLUDE = {
  documents: {
    select: { path: true },
    where: {
      OR: [
        { path: { contains: 'zh' } },
        { path: { contains: 'en' } },
        { path: { contains: 'ja' } },
      ],
    },
    take: ENGINE_CONFIG.pagination.homeReposLimit,
  },
} satisfies Prisma.RepositoryInclude;

/** 公共仓行类型：由 include 投影推导（documents 路径列表 + savedRepos 计数，严格排除系统转录服务账号） */
const PUBLIC_REPO_INCLUDE = {
  ...LANG_DOC_INCLUDE,
  _count: {
    select: {
      savedRepos: {
        where: {
          userId: { not: SYSTEM_BATCH_TRANSCRIBER_USER_ID },
        },
      },
      documents: true,
    },
  },
} satisfies Prisma.RepositoryInclude;

export type PublicHomeRepoRow = Prisma.RepositoryGetPayload<{
  include: typeof PUBLIC_REPO_INCLUDE;
}>;

export interface RelayParticipantSummary {
  userId: string;
  name: string | null;
  image: string | null;
  /** 进行中（CLAIMED/TRIAL）——卡片头像高亮环 */
  active: boolean;
}

export interface RelayRepoSummary {
  /** 参与者（按完成量降序，卡片头像堆消费） */
  participants: RelayParticipantSummary[];
  /** 进行中任务数 */
  inProgress: number;
}

export interface PublicHomeData {
  publicRepos: PublicHomeRepoRow[];
  /** 基线文档投影：repositoryId → [{path,status}]（匿名可见口径） */
  docsByRepoBaseline: Record<string, Array<{ path: string; status: string }>>;
  /** 真实章节数（大纲优先）：repositoryId → 章节数（章，非细分节） */
  chapterCountsByRepo: Record<string, number>;
  /** 推荐分（hot 排序用）：repositoryId → total 分 */
  recScores: Record<string, number>;
  /** 近期 MCP 健康（多讲法聚合主卡重算推荐分用，口径与单仓一致）：repositoryId → health */
  mcpHealthByRepo: Record<string, McpHealth>;
  /** 接力聚合：repositoryId → 参与者与进行数（仅 relayEnabled 仓） */
  relayByRepo: Record<string, RelayRepoSummary>;
  /** 书架费展示价：repositoryId → fee（按劳动账本 × 系数；豁免判定在收藏时算，展示用统一口径） */
  shelfFees: Record<string, number>;
}

async function queryPublicHomeData(sort: HomeSortKey): Promise<PublicHomeData> {
  const publicRepos = await prisma.repository.findMany({
    where: {
      isPublic: true,
      documents: { some: {} },
    },
    orderBy:
      sort === 'hot'
        ? [{ views: 'desc' }, { createdAt: 'desc' }]
        : { createdAt: 'desc' },
    take: ENGINE_CONFIG.pagination.homeMaxRepos,
    include: PUBLIC_REPO_INCLUDE,
  });

  // BUG-05 & BUG-03 防御：对入选的公开仓库，回填拉取其同仓/同簇全部公开兄弟讲法，防抽屉讲法被截断丢失
  const existingIdSet = new Set(publicRepos.map((r) => r.id));
  const distinctOwnerRepos = Array.from(
    new Set(publicRepos.map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`))
  ).map((key) => {
    const [owner, repo] = key.split('/');
    return { owner: { equals: owner, mode: 'insensitive' as const }, repo: { equals: repo, mode: 'insensitive' as const } };
  });
  const clusterKeys = Array.from(
    new Set(publicRepos.map((r) => r.sourceClusterKey).filter((k): k is string => Boolean(k && k.trim())))
  );

  const siblingOrConditions: Prisma.RepositoryWhereInput[] = [];
  if (distinctOwnerRepos.length > 0) {
    siblingOrConditions.push({ OR: distinctOwnerRepos });
  }
  if (clusterKeys.length > 0) {
    siblingOrConditions.push({ sourceClusterKey: { in: clusterKeys } });
  }

  let hydratedPublicRepos = publicRepos;
  if (siblingOrConditions.length > 0) {
    const siblingRepos = await prisma.repository.findMany({
      where: {
        isPublic: true,
        documents: { some: {} },
        id: { notIn: Array.from(existingIdSet) },
        OR: siblingOrConditions,
      },
      // 缩放护栏：超热仓被大量讲法导入时限幅；确定性排序保证截断时基础行存活
      take: ENGINE_CONFIG.pagination.homeEditionHydrateMax,
      orderBy: [{ edition: 'asc' }, { updatedAt: 'desc' }],
      include: PUBLIC_REPO_INCLUDE,
    });
    if (siblingRepos.length > 0) {
      hydratedPublicRepos = [...publicRepos, ...siblingRepos];
    }
  }

  const repoIds = hydratedPublicRepos.map((r) => r.id);

  // ── 大纲即作用域（Outline As Scope - 346 统一认知 #4：File ≠ Cognitive Unit）：
  // 教学大纲（TutorialOutline）是认知单元的唯一事实源。
  // 激活大纲中的节点对应实际教学课时；物理 Document 仅在无大纲的存量仓库中兜底平铺。
  const activeOutlines = repoIds.length
    ? await prisma.tutorialOutline.findMany({
        where: { repositoryId: { in: repoIds }, isActive: true },
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
                  document: {
                    select: {
                      id: true,
                      path: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
    : [];

  const outlineRepoIdSet = new Set(activeOutlines.map((o) => o.repositoryId));
  const fallbackRepoIds = repoIds.filter((id) => !outlineRepoIdSet.has(id));

  // 基线文档投影（ownerUserId=null）：仅对无激活大纲的存量仓查询物理文档
  const fallbackDocs = fallbackRepoIds.length
    ? await prisma.document.findMany({
        where: { repositoryId: { in: fallbackRepoIds }, ownerUserId: null },
        select: { repositoryId: true, path: true, status: true },
      })
    : [];

  const docsByRepoBaseline: Record<string, Array<{ path: string; status: string }>> = {};
  const chapterCountsByRepo: Record<string, number> = {};

  // 1. 优先从激活大纲投影：仅计入课程编排内的节点，章节数严格取 chapters 数量
  for (const outline of activeOutlines) {
    chapterCountsByRepo[outline.repositoryId] = outline.chapters.length;
    const list: Array<{ path: string; status: string }> = [];
    for (const chapter of outline.chapters) {
      for (const node of chapter.nodes) {
        if (node.document && node.document.path) {
          list.push({
            path: node.document.path,
            status: node.document.status || 'PROCESSED',
          });
        } else {
          list.push({
            path: node.headingPath || `node-${node.documentId || chapter.id}`,
            status: 'UNPROCESSED',
          });
        }
      }
    }
    docsByRepoBaseline[outline.repositoryId] = list;
  }

  // 2. 无激活大纲的存量仓，回退平铺物理文档
  for (const d of fallbackDocs) {
    if (!d || !d.repositoryId || !d.path) continue;
    (docsByRepoBaseline[d.repositoryId] ??= []).push({
      path: d.path,
      status: d.status || 'PROCESSED',
    });
  }

  for (const [rid, list] of Object.entries(docsByRepoBaseline)) {
    if (chapterCountsByRepo[rid] === undefined) {
      chapterCountsByRepo[rid] = list.length;
    }
  }

  // 推荐分：全量仓批量计算（一条 MCP 健康 groupBy + 纯函数打分）
  const recScores: Record<string, number> = {};
  const mcpHealthByRepo: Record<string, McpHealth> = {};
  if (repoIds.length > 0) {
    const { fetchMcpHealthForRepos, computeRecommendationScore } = await import(
      '@/lib/recommendation/score'
    );
    const mcpHealth = await fetchMcpHealthForRepos(repoIds);
    for (const repo of hydratedPublicRepos) {
      // unavailable stub（LLM 降级存库的假 0 分）按缺通道处理；0-10 启发式归一仅保护历史十分制行
      const llmJson = repo.reviewLlm as Record<string, unknown> | null | undefined;
      const rawLlm = llmJson?.unavailable ? null : (llmJson?.overallScore as number | null | undefined);
      const normLlm =
        rawLlm != null ? (rawLlm <= 10 && rawLlm > 0 ? Math.round(rawLlm * 10) : rawLlm) : null;
      const health = mcpHealth.get(repo.id);
      if (health) {
        mcpHealthByRepo[repo.id] = health;
      }
      const score = computeRecommendationScore(
        {
          savedCount: repo._count?.savedRepos ?? 0,
          helpfulCount: repo.helpfulCount ?? 0,
          mcpCallCount: repo.mcpCallCount ?? 0,
          updatedAt: repo.updatedAt ?? new Date(0),
          reviewPipelineTotal: (repo.reviewPipeline as Record<string, unknown> | null)?.total as number | null ?? null,
          reviewLlmScore: normLlm,
        },
        health,
      );
      recScores[repo.id] = score.total;
    }
  }

  // 接力聚合（第三批）：relayEnabled 仓的参与者与进行中任务数（卡片头像堆消费）
  const relayByRepo: Record<string, RelayRepoSummary> = {};
  const relayRepoIds = hydratedPublicRepos.filter((r) => r.relayEnabled).map((r) => r.id);
  if (relayRepoIds.length > 0) {
    const relayJobs = await prisma.chapterUpdateJob.findMany({
      where: { repositoryId: { in: relayRepoIds }, status: { in: ['CLAIMED', 'TRIAL', 'SWAPPED'] } },
      select: { repositoryId: true, status: true, claimedBy: true },
    });
    const userIds = [...new Set(relayJobs.map((j) => j.claimedBy).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, image: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const job of relayJobs) {
      const user = job.claimedBy ? userById.get(job.claimedBy) : undefined;
      if (!user) continue;
      const summary = (relayByRepo[job.repositoryId] ??= { participants: [], inProgress: 0 });
      if (job.status !== 'SWAPPED') summary.inProgress++;
      let participant = summary.participants.find((p) => p.userId === user.id);
      if (!participant) {
        participant = { userId: user.id, name: user.name, image: user.image, active: false };
        summary.participants.push(participant);
      }
      if (job.status !== 'SWAPPED') participant.active = true;
    }
    // 进行中者在前（头像堆稳定展示）
    for (const summary of Object.values(relayByRepo)) {
      summary.participants.sort((a, b) => Number(b.active) - Number(a.active));
    }
  }

  // 书架费展示价（收费透明化）：劳动账本 × 系数。展示口径统一——豁免/私有不在此判定
  // （收藏时精确计算），让用户先看到锚定价，鼓励「贡献即免费」的预期。
  const { getDynamicCreditsConfig } = await import('@/lib/credits-config');
  const { resolveEffectiveShelfFee } = await import('@/lib/credits/shelf-fee');
  const config = await getDynamicCreditsConfig();
  const shelfFees: Record<string, number> = {};
  for (const repo of hydratedPublicRepos) {
    const docCount =
      (repo as { documentCount?: number }).documentCount ??
      repo._count?.documents ??
      docsByRepoBaseline[repo.id]?.length ??
      0;
    shelfFees[repo.id] = resolveEffectiveShelfFee({
      shelfFeeOverride: repo.shelfFeeOverride,
      transcriptionCreditsEarned: repo.transcriptionCreditsEarned,
      shelfFeeMultiplier: config.shelfFeeMultiplier,
      docCount,
    });
  }

  return {
    publicRepos: hydratedPublicRepos,
    docsByRepoBaseline,
    chapterCountsByRepo,
    recScores,
    mcpHealthByRepo,
    relayByRepo,
    shelfFees,
  };
}

// 各排序键独立缓存条目（keyParts 含 sort；tag 统一便于一次性失效）
const cacheBySort = new Map<HomeSortKey, () => Promise<PublicHomeData>>();

function getCachedGetter(sort: HomeSortKey): () => Promise<PublicHomeData> {
  let getter = cacheBySort.get(sort);
  if (!getter) {
    getter = unstable_cache(
      () => queryPublicHomeData(sort),
      // v6：支持 Repository.shelfFeeOverride 单仓书架费覆盖
      ['public-home-data-v6', sort],
      {
        tags: [PUBLIC_HOME_CACHE_TAG],
        revalidate: ENGINE_CONFIG.pagination.homeCacheTtlSeconds,
      },
    );
    cacheBySort.set(sort, getter);
  }
  return getter;
}

/** 首页公共数据读取入口（sort 自动归一化） */
export async function getPublicHomeData(sortRaw?: string | null): Promise<PublicHomeData> {
  return getCachedGetter(normalizeHomeSort(sortRaw))();
}
