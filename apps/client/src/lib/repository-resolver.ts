import { cache } from 'react';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveTranscriptionPreset } from '@/lib/transcription-presets';
import { docVisibilityFilter } from '@/lib/auth-utils';

export {
  isWebDocRepository,
  isNativeWebDocMirror,
  resolveRepositoryDisplayName,
  resolveLocalizedRepoDescription,
  extractWebDocOrigin,
  isGenericWebDocTitle,
} from '@/lib/repository-origin';

/**
 * 从 navTree 中查找文档页的页面级原站 sourceUrl。
 * 若节点未显式挂载 sourceUrl，回退至 fallbackRootUrl（通常为 repoProfile.originalUrl 根路径）。
 * 注意：只输出页面级真实 URL，不拼接 heading 锚点，确保生成的链接 100% 可访问且不生成死链。
 */
export function resolveDocLiveUrl(
  navTree: unknown,
  docPath: string,
  fallbackRootUrl?: string | null
): string | null {
  if (!Array.isArray(navTree) || !docPath) return fallbackRootUrl || null;
  const target = docPath.toLowerCase().replace(/\.mdx?$/, '');

  function walk(nodes: any[]): string | null {
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        if (node.path) {
          const nodePath = String(node.path).toLowerCase().replace(/\.mdx?$/, '');
          if (nodePath === target && typeof node.sourceUrl === 'string' && node.sourceUrl.trim()) {
            return node.sourceUrl.trim();
          }
        }
        if (Array.isArray(node.children)) {
          const found = walk(node.children);
          if (found) return found;
        }
      }
    }
    return null;
  }

  return walk(navTree) || fallbackRootUrl || null;
}

export interface RepositoryVersionOption {
  branch: string;
  semVerLabel: string | null;
  isDefault: boolean;
  label: string;
}

/** 讲法条目（文档页切换器 / 广场·书架分组展示消费） */
export interface RepositoryEditionOption {
  /** Repository 行 id（行级收藏 connect 用） */
  id: string;
  /** 讲法 key（'' = 基础讲法；URL ?edition= 用） */
  edition: string;
  /** 显示名（repoProfile.editionLabel > 转录预设名 > 基础讲法） */
  label: string;
  /** 生成该讲法所用预设 id（可空） */
  presetId: string | null;
  isDefault: boolean;
  branch: string;
  isPublic: boolean;
  transcriptionModels?: string[];
  createdAt?: string;
  updatedAt?: string;
  chapterCount?: number;
  processedDocsCount?: number;
  creatorName?: string | null;
  isCurrentUserCreator?: boolean;
  wordCount?: number;
  teachingDepth?: string;
  relayEnabled?: boolean;
  isFullyTranscribed?: boolean;
  reviewPipeline?: unknown;
  reviewLlm?: unknown;
  /** 剩余可申请重新评分次数 (最多 3 次) */
  reviewAppealsRemaining?: number;
  relay?: {
    total: number;
    done: number;
    inProgress: number;
    participants?: Array<{
      userId?: string;
      name?: string | null;
      image?: string | null;
      active?: boolean;
    }>;
  } | null;
}

export interface ResolvedRepositoryResult {
  repository: any;
  resolvedBranch: string;
  targetVersionLabel?: string;
  isFallback: boolean;
  /** 实际命中的讲法 key（显式 edition 未命中回退基础行时与入参不同，调用方据此提示） */
  resolvedEdition: string;
  /**
   * 类型化讲法未命中（纯推导，零额外查询）：级联走到回退点即证明该 edition 无任何行
   * （前面的查询已无分支约束地穷尽 branch/version 维度）。
   * 变更类端点应据此 fail-closed（鉴权与操作不得静默落在基础行）；
   * 展示类端点可保留回退（横幅/redirect 各自取舍）。未显式传 edition 时永无此字段。
   */
  editionMiss?: { requested: string };
}

/** 基础教程的显示名兜底（无 editionLabel 且无预设信息时） */
const BASE_EDITION_LABEL = '标准教程';

/** 路由层取 ?edition= 查询参数（缺省 ''，即基础讲法——与既有行为完全一致） */
export function editionParamFromUrl(request: Request | { nextUrl?: URL }): string {
  try {
    const url = (request as Request).url ? new URL((request as Request).url) : (request as { nextUrl?: URL }).nextUrl;
    if (!url) return '';
    return url.searchParams.get('edition') ?? '';
  } catch {
    // 容错降级: 非法 URL 视为无讲法参数（与缺省 '' 同语义）
    return '';
  }
}

/**
 * 从 repoProfile 推导教程版本显示名（纯函数，服务端分组与切换器共用）。
 * 优先级：用户自定义个性化标题 > 驱动/转录模型名称 > 非标转录预设名（如深度剖析版、速查手册版）> 标准教程。
 * 核心守约：转录模型为首，绝不将默认预设（standard）作为特征版本名渲染为“教学解读版”。
 */
export function deriveEditionLabel(
  repoProfile: unknown,
  transcriptionModels?: string[] | null
): string {
  const modelFromArgs = transcriptionModels?.[0]?.trim() || '';
  const profile =
    repoProfile && typeof repoProfile === 'object'
      ? (repoProfile as Record<string, unknown>)
      : null;

  if (profile) {
    if (typeof profile.editionLabel === 'string' && profile.editionLabel.trim() !== '') {
      const trimmed = profile.editionLabel.trim();
      // 排除机生占位符（如 "讲法 ..."、"ed_..."、"默认"、"标准教程"、"教学解读版"、"教学解读"），保留用户自定义的个性化标题
      if (
        !/^讲法\s+/i.test(trimmed) &&
        !/^ed_[a-z0-9_]+$/i.test(trimmed) &&
        trimmed !== '标准教程' &&
        trimmed !== '默认' &&
        trimmed !== '教学解读版' &&
        trimmed !== '教学解读'
      ) {
        return trimmed;
      }
    }
  }

  // 首选以驱动/转录模型（如 qwen3.8-max、glm-5.3-flash）作为版本标识
  const profileModel =
    profile
      ? (typeof profile.transcriptionModel === 'string' && profile.transcriptionModel.trim()) ||
        (typeof profile.model === 'string' && profile.model.trim()) ||
        (typeof profile.activeModel === 'string' && profile.activeModel.trim()) ||
        ''
      : '';
  const effectiveModel = modelFromArgs || profileModel;
  if (effectiveModel) return effectiveModel;

  if (profile) {
    const presetId =
      typeof profile.editionPreset === 'string' ? profile.editionPreset
      : typeof profile.transcriptionPreset === 'string' ? profile.transcriptionPreset
      : null;
    if (presetId) {
      const preset = resolveTranscriptionPreset(presetId);
      // 绝不将 standard 默认预设渲染为“教学解读版”；仅非标风格（deep、cheatsheet 等）回退风格名
      if (preset.id !== 'standard') {
        return `${preset.name}版`;
      }
    }
  }
  return BASE_EDITION_LABEL;
}

/** 讲法维度确定性排序：基础行（''）最优先，其余按 key 字典序，末级 updatedAt 兜底 */
const EDITION_ORDER: [{ edition: 'asc' }, { updatedAt: 'desc' }] = [{ edition: 'asc' }, { updatedAt: 'desc' }];

/**
 * Dynamically resolves the target repository and version context for given owner/repo and requested branch/version.
 * Eliminates hardcoded 'main' assumptions across API endpoints, MCP server, and UI layout.
 *
 * edition 维度：显式传入未命中时回退基础讲法行（isFallback=true）；未传入时锁定基础行，
 * 杜绝多讲法行并存时的随机返回（历史 findFirst 无排序问题）。
 */
export async function resolveRepository(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  includeClause?: any
): Promise<ResolvedRepositoryResult | null> {
  if (!owner || !repo) return null;

  // Handle legacy route prefix fallback if owner is 'personal' or 'default'
  if (owner === 'personal' || owner === 'default') {
    const legacyRepo = await prisma.repository.findFirst({
      where: { repo, edition: edition ?? '' },
      orderBy: EDITION_ORDER,
      include: includeClause && typeof includeClause === 'object' ? includeClause : undefined
    });
    if (legacyRepo) {
      return {
        repository: legacyRepo,
        resolvedBranch: legacyRepo.branch,
        targetVersionLabel: legacyRepo.semVerLabel || undefined,
        isFallback: true,
        resolvedEdition: legacyRepo.edition ?? ''
      };
    }
  }

  const defaultBranch = ENGINE_CONFIG.defaultBranch;
  const hasInclude = includeClause && typeof includeClause === 'object';
  const wantedEdition = edition ?? '';

  // BUG-06 防御：大小写不敏感匹配，确保用户在地址栏手动输入大写或混写 URL 时不报 404
  const ownerWhere = { equals: owner.trim(), mode: 'insensitive' as const };
  const repoWhere = { equals: repo.trim(), mode: 'insensitive' as const };

  // 1. If explicit version/branch requested, try exact match first
  if (versionOrBranch && versionOrBranch !== 'latest' && versionOrBranch !== 'default') {
    const cleanVer = versionOrBranch.trim();

    // Exact branch match (scoped to edition)
    const exactBranchRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, branch: cleanVer, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (exactBranchRepo) {
      return {
        repository: exactBranchRepo,
        resolvedBranch: exactBranchRepo.branch,
        targetVersionLabel: exactBranchRepo.semVerLabel || undefined,
        isFallback: false,
        resolvedEdition: exactBranchRepo.edition ?? ''
      };
    }

    // Exact semVerLabel match (scoped to edition)
    const exactSemVerRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, semVerLabel: cleanVer, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (exactSemVerRepo) {
      return {
        repository: exactSemVerRepo,
        resolvedBranch: exactSemVerRepo.branch,
        targetVersionLabel: exactSemVerRepo.semVerLabel || cleanVer,
        isFallback: false,
        resolvedEdition: exactSemVerRepo.edition ?? ''
      };
    }

    // Partial semVerLabel match (e.g. "v15" matching "v15.0.0")
    const partialRepo = await prisma.repository.findFirst({
      where: {
        owner: ownerWhere,
        repo: repoWhere,
        edition: wantedEdition,
        semVerLabel: {
          contains: cleanVer,
          mode: 'insensitive'
        }
      },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (partialRepo) {
      return {
        repository: partialRepo,
        resolvedBranch: partialRepo.branch,
        targetVersionLabel: partialRepo.semVerLabel || cleanVer,
        isFallback: false,
        resolvedEdition: partialRepo.edition ?? ''
      };
    }

    // If no separate repository row matched, check if primary repo contains chunks with this semVerLabel
    const primaryRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, branch: defaultBranch, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    }) || await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (primaryRepo) {
      return {
        repository: primaryRepo,
        resolvedBranch: primaryRepo.branch,
        targetVersionLabel: cleanVer,
        isFallback: true,
        resolvedEdition: primaryRepo.edition ?? ''
      };
    }

    // 显式讲法未命中：回退基础讲法行（保持旧链接/已删讲法可达，isFallback 标记）。
    // 走到此处即证明该 edition 无任何行（Step 1~4 已穷尽 branch/version 维度）→ 纯推导标记 editionMiss。
    if (wantedEdition !== '') {
      const fallback = await resolveRepository(owner, repo, versionOrBranch, '', includeClause);
      if (fallback) {
        return {
          ...fallback,
          isFallback: true,
          editionMiss: { requested: wantedEdition },
        };
      }
      return null;
    }
    return null;
  }

  // 2. Default: fetch default branch or latest updated repository instance
  const defaultRepo = await prisma.repository.findFirst({
    where: { owner: ownerWhere, repo: repoWhere, branch: defaultBranch, edition: wantedEdition },
    orderBy: EDITION_ORDER,
    include: hasInclude ? includeClause : undefined
  }) || await prisma.repository.findFirst({
    where: { owner: ownerWhere, repo: repoWhere, edition: wantedEdition },
    orderBy: EDITION_ORDER,
    include: hasInclude ? includeClause : undefined
  });

  if (!defaultRepo && wantedEdition !== '') {
    const fallback = await resolveRepository(owner, repo, versionOrBranch, '', includeClause);
    if (fallback) {
      return {
        ...fallback,
        isFallback: true,
        editionMiss: { requested: wantedEdition },
      };
    }
    return null;
  }
  if (!defaultRepo && wantedEdition === '') {
    const fallbackAnyEdition = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere },
      orderBy: [{ updatedAt: 'desc' }],
      include: hasInclude ? includeClause : undefined
    });
    if (fallbackAnyEdition) {
      return {
        repository: fallbackAnyEdition,
        resolvedBranch: fallbackAnyEdition.branch,
        targetVersionLabel: fallbackAnyEdition.semVerLabel || undefined,
        isFallback: true,
        resolvedEdition: fallbackAnyEdition.edition ?? ''
      };
    }
  }
  if (!defaultRepo) return null;

  return {
    repository: defaultRepo,
    resolvedBranch: defaultRepo.branch,
    targetVersionLabel: defaultRepo.semVerLabel || undefined,
    isFallback: false,
    resolvedEdition: defaultRepo.edition ?? ''
  };
}

/**
 * Retrieves all available versions and branches across repository instances and document chunks for a given owner/repo.
 */
export async function getRepositoryVersions(owner: string, repo: string): Promise<RepositoryVersionOption[]> {
  if (!owner || !repo) return [];

  // BUG-06 同口径：大小写不敏感匹配（公开路由直接透传 URL 原始参数，混写大小写不可 404/空列表）
  const ownerWhere = { equals: owner.trim(), mode: 'insensitive' as const };
  const repoWhere = { equals: repo.trim(), mode: 'insensitive' as const };

  // 1. Fetch all repository instances for owner/repo
  const repos = await prisma.repository.findMany({
    where: { owner: ownerWhere, repo: repoWhere },
    select: { branch: true, semVerLabel: true }
  });

  // 2. Fetch distinct semVerLabels from chunks across any repository instance of owner/repo
  const chunkVersions = await prisma.documentChunk.findMany({
    where: {
      document: {
        repository: {
          owner: ownerWhere,
          repo: repoWhere
        },
        // 真冻结：版本标签只取共享文档的（无用户上下文，避免泄露私有副本元数据）
        ownerUserId: null
      },
      semVerLabel: { not: null }
    },
    distinct: ['semVerLabel'],
    select: { semVerLabel: true }
  }).catch((err) => {
    // 容错降级: 版本选项查询失败降级为空列表（切换器隐藏版本维度），留痕观测
    console.warn('[repository-resolver] version options query failed:', err);
    return [];
  });

  const optionsMap = new Map<string, RepositoryVersionOption>();

  for (const r of repos) {
    const key = r.semVerLabel || r.branch;
    const label = r.semVerLabel ? `${r.semVerLabel} (${r.branch})` : r.branch;
    optionsMap.set(key, {
      branch: r.branch,
      semVerLabel: r.semVerLabel,
      isDefault: r.branch === ENGINE_CONFIG.defaultBranch,
      label
    });
  }

  for (const cv of chunkVersions) {
    if (cv.semVerLabel && !optionsMap.has(cv.semVerLabel)) {
      optionsMap.set(cv.semVerLabel, {
        branch: ENGINE_CONFIG.defaultBranch,
        semVerLabel: cv.semVerLabel,
        isDefault: false,
        label: cv.semVerLabel
      });
    }
  }

  const result = Array.from(optionsMap.values());
  // Sort with 'main'/default first, then semVer descending/alphabetical
  result.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return b.label.localeCompare(a.label);
  });

  return result;
}

/**
 * 无 searchParams 上下文的消费方（docs layout 等）专用：基础行优先，无基础行时
 * 回退组内首个讲法行（讲法行与基础行共享同一批文档路径，navTree 结构等价）。
 * 不做可见性过滤——鉴权由调用方（verifyRepoAccessDirect）把关，与既有模式一致。
 */
async function resolveRepositoryAnyEditionImpl(
  owner: string,
  repo: string,
  includeClause?: any
): Promise<ResolvedRepositoryResult | null> {
  if (!owner || !repo) return null;
  const row = await prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
    },
    orderBy: EDITION_ORDER,
    include: includeClause && typeof includeClause === 'object' ? includeClause : undefined
  });
  if (!row) return null;
  return {
    repository: row,
    resolvedBranch: row.branch,
    targetVersionLabel: row.semVerLabel || undefined,
    isFallback: false,
    resolvedEdition: row.edition ?? ''
  };
}

// 请求级 memo：docs layout 的 generateMetadata 与 body 各调用一次（同 owner/repo），
// 字符串参数经 Object.is 直接命中。includeClause 传对象时不参与命中（引用不等 →
// 缓存 miss → 原样执行），安全降级；返回对象在同请求内共享，消费方均为只读。
export const resolveRepositoryAnyEdition = cache(resolveRepositoryAnyEditionImpl);

/**
 * 组内首个公开行（带文档，EDITION_ORDER 确定性排序：基础行优先）。
 * 可见性回退用：基础行被他人私有导入遮蔽时，匿名/无关访客改读组内公开讲法行。
 */
export async function findPublicGroupRow(owner: string, repo: string) {
  if (!owner || !repo) return null;
  return prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      isPublic: true,
      documents: { some: {} },
    },
    orderBy: EDITION_ORDER,
  });
}

/** 组内是否存在任一公开行（SEO noindex/index 判定；单查询 select id） */
export async function isRepositoryGroupPublic(owner: string, repo: string): Promise<boolean> {
  if (!owner || !repo) return false;
  const row = await prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      isPublic: true,
    },
    select: { id: true },
  });
  return !!row;
}

/**
 * 组内可见讲法清单（讲法切换器 / 分组展示数据源）：
 * 公开讲法行 + （登录时）本人书架内的私有讲法行；基础行排首位。
 * branch 过滤可选——文档页切换器按当前分支列讲法（跨分支讲法随版本切换呈现）。
 */
export async function getRepositoryEditions(
  owner: string,
  repo: string,
  opts?: { userId?: string | null; branch?: string }
): Promise<RepositoryEditionOption[]> {
  if (!owner || !repo) return [];
  const rows = await prisma.repository.findMany({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      ...(opts?.branch ? { branch: opts.branch } : {}),
      OR: [
        { isPublic: true },
        ...(opts?.userId
          ? [
              { savedRepos: { some: { userId: opts.userId } } },
              { importRecords: { some: { userId: opts.userId } } },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      branch: true,
      edition: true,
      repoProfile: true,
      isPublic: true,
      transcriptionModels: true,
      relayEnabled: true,
      updatedAt: true,
      createdAt: true,
      reviewPipeline: true,
      reviewLlm: true,
      importRecords: {
        select: {
          userId: true,
          user: {
            select: { id: true, name: true, image: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
    orderBy: EDITION_ORDER,
  }).catch((err) => {
    // 容错降级: 讲法列表查询失败降级为空（讲法切换器隐藏），留痕观测
    console.warn('[repository-resolver] edition rows query failed:', err);
    return [];
  });

  // 计数与模型词汇聚合下推 SQL（原嵌套 documents select 每 10s 轮询把全部章节行
  // 逐行拉回 Node 只为 count/distinct——观众数 × 讲法数的带宽放大器；group by
  // 只传分组结果，行传输量从 O(章节总数) 降为 O(状态数 + 模型数)）
  const repoIds = rows.map((r) => r.id);
  const docFilter = docVisibilityFilter(opts?.userId);
  const [statusGroups, modelGroups] = repoIds.length
    ? await Promise.all([
        prisma.document
          .groupBy({
            by: ['repositoryId', 'status'],
            _count: { _all: true },
            where: { repositoryId: { in: repoIds }, ...docFilter },
          })
          .catch((err) => {
            // 容错降级: 状态聚合计数失败降级为空（讲法卡片计数隐藏），留痕观测
            console.warn('[repository-resolver] status groupBy failed:', err);
            return [];
          }),
        prisma.document
          .groupBy({
            by: ['repositoryId', 'generationModel'],
            where: {
              repositoryId: { in: repoIds },
              generationModel: { not: null },
              ...docFilter,
            },
          })
          .catch((err) => {
            // 容错降级: 模型词汇聚合失败降级为空（讲法卡片模型徽标隐藏），留痕观测
            console.warn('[repository-resolver] model groupBy failed:', err);
            return [];
          }),
      ] as const)
    : ([[], []] as const);

  const docCountByRepo = new Map<string, { total: number; processed: number }>();
  for (const g of statusGroups) {
    const entry = docCountByRepo.get(g.repositoryId) ?? { total: 0, processed: 0 };
    entry.total += g._count._all;
    if (g.status === 'PROCESSED') entry.processed += g._count._all;
    docCountByRepo.set(g.repositoryId, entry);
  }
  const docModelsByRepo = new Map<string, string[]>();
  for (const g of modelGroups) {
    const model = typeof g.generationModel === 'string' ? g.generationModel.trim() : '';
    if (!model) continue;
    const list = docModelsByRepo.get(g.repositoryId) ?? [];
    list.push(model);
    docModelsByRepo.set(g.repositoryId, list);
  }

  return rows.map((r) => {
    const profile = (r.repoProfile ?? {}) as Record<string, unknown>;
    const presetId =
      typeof profile.editionPreset === 'string' ? profile.editionPreset : null;
    const counts = docCountByRepo.get(r.id) ?? { total: 0, processed: 0 };
    const totalDocs = counts.total;
    const processedDocs = counts.processed;

    const firstImportRecord = (r as any).importRecords?.[0];
    const firstImportUser = firstImportRecord?.user;
    const rawImportUserName =
      typeof firstImportUser?.name === 'string' && firstImportUser.name.trim().length > 0
        ? firstImportUser.name.trim()
        : null;
    const profileCreator =
      typeof profile.creator === 'string' && profile.creator.trim().length > 0
        ? profile.creator.trim()
        : typeof profile.creatorName === 'string' && profile.creatorName.trim().length > 0
        ? profile.creatorName.trim()
        : null;
    const creatorName = rawImportUserName || profileCreator || null;

    const firstImportUserId = firstImportRecord?.userId || firstImportUser?.id;
    const isCurrentUserCreator = Boolean(
      opts?.userId &&
        ((firstImportUserId && firstImportUserId === opts.userId) ||
          (typeof profile.creatorId === 'string' && profile.creatorId === opts.userId))
    );

    // 字数只取落库物理事实 repoProfile.totalWords；缺失时置 undefined（UI 端不渲染该字段），
    // 绝不估算编数。原实现为现算 content 长度和，导致 ingest-status 每 10s 轮询把该仓
    // 全部讲法的章节 MDX 正文整批拉回 Node 内存（CDC 载荷裁剪公理违例，已移除）。
    let wordCount: number | undefined;
    if (
      typeof profile.totalWords === 'number' &&
      Number.isFinite(profile.totalWords) &&
      profile.totalWords >= 0
    ) {
      wordCount = profile.totalWords;
    }

    const preset = presetId ? resolveTranscriptionPreset(presetId) : null;
    const rawTeachingDepth =
      typeof profile.teachingDepth === 'string' && profile.teachingDepth.trim().length > 0
        ? profile.teachingDepth.trim()
        : null;
    const teachingDepth = rawTeachingDepth || preset?.defaults?.teachingDepth || undefined;

    const rawModels = (r.transcriptionModels || []).filter(Boolean);
    const docModels = Array.from(new Set(docModelsByRepo.get(r.id) ?? []));
    const profileModel =
      typeof profile.transcriptionModel === 'string' && profile.transcriptionModel.trim()
        ? profile.transcriptionModel.trim()
        : typeof profile.model === 'string' && profile.model.trim()
        ? profile.model.trim()
        : typeof profile.activeModel === 'string' && profile.activeModel.trim()
        ? profile.activeModel.trim()
        : null;

    const effectiveModels =
      rawModels.length > 0
        ? rawModels
        : docModels.length > 0
        ? docModels
        : profileModel
        ? [profileModel]
        : [];

    const isFullyTranscribed = totalDocs > 0 && processedDocs >= totalDocs;

    return {
      id: r.id,
      edition: r.edition ?? '',
      label: deriveEditionLabel(r.repoProfile, effectiveModels),
      presetId,
      isDefault: (r.edition ?? '') === '',
      branch: r.branch,
      isPublic: r.isPublic,
      transcriptionModels: effectiveModels,
      createdAt: r.createdAt ? r.createdAt.toISOString() : undefined,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : undefined,
      chapterCount: totalDocs,
      processedDocsCount: processedDocs,
      creatorName,
      isCurrentUserCreator,
      wordCount,
      teachingDepth,
      relayEnabled: Boolean(r.relayEnabled),
      isFullyTranscribed,
      reviewPipeline: r.reviewPipeline ?? null,
      reviewLlm: r.reviewLlm ?? null,
      reviewAppealsRemaining: typeof profile.reviewAppealsRemaining === 'number' ? profile.reviewAppealsRemaining : 3,
      relay: (r.relayEnabled && totalDocs > 0 && processedDocs < totalDocs)
        ? { done: processedDocs, total: totalDocs, inProgress: 0, participants: [] }
        : null,
    };
  });
}
