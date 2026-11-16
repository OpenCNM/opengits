import { cache } from 'react';
import { prisma } from '@/lib/db';
import { findVisibleDoc } from '@/lib/docs-fetch';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { resolveRepository, findPublicGroupRow } from '@/lib/repository-resolver';
import { getActiveOutline, resolveDocPathFromOutline, outlineNodeUrl, firstNavigableNode, docPathToSlug, type OutlineView } from '@/lib/outline-reader';
import { resolveEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { applyContentLayerRead } from '@/lib/content-addressing';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import type { ChapterAsset } from '@/components/mdx/ChapterFoldout';
import type { ChapterMapEntry } from '@/engine/chapter-map';
import { GITHUB_ENDPOINTS, ENGINE_CONFIG } from '@/lib/config';
import { isWebDocRepository } from '@/lib/repository-resolver';
import { getWebL1OutlineProjectionById } from './web-outline-projection';
import { createTtlMicroCache } from './ttl-microcache';
import { executeSidecarConceptGrounding } from '@/engine/symbols-driver';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';

/**
 * 章节附页资产 → 可打开的外链 URL。
 * GitHub 仓组装 blob 绝对地址（相对 path 会被前端当站内路由 → 404）；
 * web 文档仓与已是绝对地址的资产原样透传。
 */
export function buildRepoAssetUrl(
  owner: string,
  repo: string,
  branch: string | null | undefined,
  assetPath: string
): string | undefined {
  if (/^https?:\/\//i.test(assetPath)) return assetPath;
  if (isWebDocRepository({ owner, repo })) return undefined;
  const ref = branch || ENGINE_CONFIG.defaultBranch;
  return `${GITHUB_ENDPOINTS.web}/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

export interface LoadDocPageOptions {
  owner: string;
  repo: string;
  slug?: string[];
  version?: string;
  branch?: string;
  edition?: string;
  versionParam?: string;
  userId?: string | null;
}

export interface DocCognitiveScaffold {
  subsystemName: string;
  subsystemDuty?: string;
  backboneFiles: Array<{
    path: string;
    role: string;
    pageRank: number;
  }>;
}

export function inferDocSubsystem(
  docPath: string,
  docTitle?: string | null
): { subsystemName: string; subsystemDuty: string } {
  const cleanPath = (docPath || '').replace(/^[0-9]+[_-]/, '').replace(/\.mdx?$/, '');
  let segments = cleanPath.split('/').filter(Boolean);
  if (segments.length > 1 && /^(docs?|documentation|guide|manual|book|wiki|site)$/i.test(segments[0])) {
    segments = segments.slice(1);
  }
  const subsystemRaw = segments.length > 1 ? segments[0] : (segments[0] || 'core');
  const subsystemName = subsystemRaw.replace(/^[0-9]+[_-]/, '') || 'core';

  let subsystemDuty: string | undefined;
  const combinedContext = `${subsystemName} ${docPath} ${docTitle || ''}`;
  for (const rule of MODULE_ROLE_PATTERNS.subsystemDuties) {
    if (rule.pattern.test(combinedContext)) {
      subsystemDuty = rule.description;
      break;
    }
  }
  if (!subsystemDuty) {
    subsystemDuty = `负责 ${subsystemName} 子模块的核心功能实现与物理代码拓扑流。`;
  }

  return { subsystemName, subsystemDuty };
}

// 章节多版本生效投影已收编至 lib/state/chapter-version-projector（纯投影族），
// 此处 re-export 保持既有导入路径兼容（消费方零迁移）
export {
  resolveEffectiveChapterVersion,
  type ChapterVersionSummary,
  type ResolveEffectiveVersionOptions,
  type ResolvedChapterVersionResult,
} from '@/lib/state/chapter-version-projector';
import { resolveEffectiveChapterVersion, type ChapterVersionSummary } from '@/lib/state/chapter-version-projector';

export type DocPageResolution =
  | { type: 'not-found' }
  | { type: 'redirect'; url: string }
  | {
      type: 'doc';
      repository: any;
      doc: any & { cognitiveScaffold?: DocCognitiveScaffold | null };
      relativePath: string;
      rawPath: string;
      syncHistory: any[];
      showAutoSyncSwitch: boolean;
      unprocessedCount: number;
      chapterVersions: any[];
      viewerVersionVotes: Set<string>;
      activeVersion: any | null;
      activeUpdateJob: any | null;
      repoProfile: any | null;
      chapterAssets?: ChapterAsset[] | null;
      /** 显式 ?edition= 未命中被静默回退时的提示面（P3-10：不再无声展示基础讲法） */
      editionFallback?: { requestedEdition: string };
      cognitiveScaffold?: DocCognitiveScaffold | null;
    };

export interface CachedRepoDocPageMetadata {
  syncHistory: any[];
  maintainerId: string | null;
  unprocessedCount: number;
  repoProfile?: Record<string, any> | null;
}

const REPO_DOC_PAGE_META_TTL_MS = 60_000;
const repoPageMetaCache = new Map<string, { data: CachedRepoDocPageMetadata; expiresAt: number }>();

/**
 * 纯仓库级页面元数据缓存（60s TTL LRU 内存缓存）。
 * 章节翻页时复用 syncHistory / maintainerId / unprocessedCount，
 * 彻底消除同一仓库阅读翻页时的重复关联数据库查询。
 */
export async function fetchRepoDocPageMetadata(
  repositoryId: string,
  owner: string,
  repo: string,
  isPublic: boolean,
  hasRepoProfile: boolean
): Promise<CachedRepoDocPageMetadata> {
  const cacheKey = `${repositoryId}:${isPublic ? 'pub' : 'priv'}`;
  const now = Date.now();
  const cached = repoPageMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const [syncHistory, maintainerId, unprocessedCount, repoWithProfile] = await Promise.all([
    prisma.importUpdateRun.findMany({
      where: { repositoryId, status: 'APPLIED' },
      select: {
        id: true,
        fromSha: true,
        toSha: true,
        finishedAt: true,
        createdAt: true,
        stats: true,
        plan: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }).catch(() => []),

    isPublic ? resolveMaintainerUserId(repositoryId).catch(() => null) : null,

    !isPublic
      ? prisma.document.count({ where: { repositoryId, ownerUserId: null, status: 'UNPROCESSED' } }).catch(() => 0)
      : 0,

    hasRepoProfile ? null : prisma.repository.findUnique({ where: { id: repositoryId }, select: { repoProfile: true } }),
  ]);

  const data: CachedRepoDocPageMetadata = {
    syncHistory,
    maintainerId,
    unprocessedCount,
    repoProfile: (repoWithProfile?.repoProfile as Record<string, any> | null) ?? null,
  };

  if (repoPageMetaCache.size >= 200) {
    const oldestKey = repoPageMetaCache.keys().next().value;
    if (oldestKey) repoPageMetaCache.delete(oldestKey);
  }

  repoPageMetaCache.set(cacheKey, { data, expiresAt: now + REPO_DOC_PAGE_META_TTL_MS });
  return data;
}

export function clearRepoDocPageMetaCacheForTest() {
  repoPageMetaCache.clear();
}

/**
 * 纯粹的文档页服务端数据装配管道。
 * 隔离数据库查询、路径回退、大纲多级定位、权限与关联模型。
 */
export async function loadDocPageData({
  owner,
  repo,
  slug,
  version,
  branch,
  edition,
  versionParam,
  userId,
}: LoadDocPageOptions): Promise<DocPageResolution> {
  const resolved = await resolveRepository(owner, repo, version || branch, edition);

  // 讲法作用域:非基础讲法的内部跳转必须携带 ?edition=,否则落回基础行
  // (文档不存在 → 404)。与 DocsEdition.appendEditionQuery 同语义。
  const editionQuery = edition ? `?edition=${encodeURIComponent(edition)}` : '';
  let repository = resolved?.repository;

  // 复用 L1 内存投影快照与大纲
  let outlineCache: OutlineView | null | undefined = undefined;
  if (repository?.id) {
    const l1Proj = await getWebL1OutlineProjectionById(repository.id);
    if (l1Proj?.repoSnapshot) {
      repository = {
        ...l1Proj.repoSnapshot,
        ...repository,
      };
      if (l1Proj.outline && l1Proj.outline.outlineId) {
        outlineCache = l1Proj.outline;
      }
    }
  }

  // 可见性回退（与 docs layout 同口径）：仅在未显式指定讲法（!edition）时，
  // 若解析行私有且访客无权读取，才改读组内公开讲法行。显式指定的讲法绝不静默篡改为其他版本。
  if (!edition && repository && !repository.isPublic && !(await verifyRepoAccessDirect(repository, userId ?? undefined))) {
    const publicRow = await findPublicGroupRow(owner, repo).catch(() => null);
    if (publicRow) {
      repository = publicRow;
    }
  }

  if (!repository) {
    return { type: 'not-found' };
  }

  // 类型化讲法未命中：307 canonical redirect 剥离过期 ?edition=（URL 栏与缓存看到真相），
  // 取代旧"基础行内容 + 横幅"——下方 editionFallback 横幅保留为最后防线，其它回退场景仍可用
  if (edition && resolved?.editionMiss) {
    const slugPath = slug && slug.length > 0 ? `/${slug.join('/')}` : '';
    return { type: 'redirect', url: `/docs/${owner}/${repo}${slugPath}` };
  }

  // 显式讲法未命中静默回退（resolver 契约：isFallback/resolvedEdition 由调用方提示）
  const editionFallback =
    edition && resolved && (resolved.resolvedEdition ?? '') !== edition
      ? { requestedEdition: edition }
      : undefined;

  // 1. Determine local file path
  const rawPath = slug ? slug.join('/') : '';

  // Canonical 规范重定向：当显式请求裸 /index、/readme 或嵌套 /sub/index 时，
  // 301 规范重定向到对应的目录基准 URL，杜绝同内容双 URL 镜像与 canonical 分散
  if (rawPath) {
    const normRaw = rawPath.toLowerCase();
    if (normRaw === 'index' || normRaw === 'readme') {
      return {
        type: 'redirect',
        url: `/docs/${owner}/${repo}${editionQuery}`,
      };
    }
    if (normRaw.endsWith('/index') || normRaw.endsWith('/readme')) {
      const parentPath = rawPath.slice(0, rawPath.lastIndexOf('/'));
      return {
        type: 'redirect',
        url: `/docs/${owner}/${repo}/${parentPath}${editionQuery}`,
      };
    }
  }

  let relativePath = rawPath;
  if (!relativePath) {
    relativePath = 'README.md';
  } else if (!/\.(md|mdx|markdown)$/i.test(relativePath)) {
    relativePath = `${relativePath}.md`;
  }

  const repoWhere = { id: repository.id };

  // 激活大纲懒加载（优先命中 L1 内存投影）
  const getOutline = async () => {
    if (outlineCache === undefined) {
      try {
        const l1Proj = await getWebL1OutlineProjectionById(repository.id);
        if (l1Proj?.outline && l1Proj.outline.outlineId) {
          outlineCache = l1Proj.outline;
          return outlineCache;
        }
        outlineCache = await getActiveOutline(repository.id);
      } catch (e) {
        console.warn('[DocsPageLoader] Failed to read active outline:', e);
        outlineCache = null;
      }
    }
    return outlineCache;
  };

  // 根路径历史阅读重定向
  if (!slug || slug.length === 0) {
    const lastReadRedirect = await resolveLastReadRedirect(userId, repository.id, owner, repo, editionQuery);
    if (lastReadRedirect) {
      return lastReadRedirect;
    }
  }

  // 2. Fetch Document from PostgreSQL
  let doc: any = null;
  if (!rawPath) {
    // 根路径（/docs/owner/repo 或 /index）：优先按激活大纲首节，再按通用候选（README / index）
    const outline = await getOutline();
    const outlineRootPath = outline ? resolveDocPathFromOutline(outline, '') : null;
    const rootCandidates = [
      outlineRootPath,
      'README.md',
      'index.md',
      'README.mdx',
      'index.mdx',
      'readme.md',
      'index.markdown',
      'README.markdown',
    ].filter((p): p is string => Boolean(p));

    doc = await findVisibleDoc(repoWhere, rootCandidates, userId ?? undefined);
    if (doc) {
      relativePath = doc.path;
    }
  } else {
    doc = await findVisibleDoc(repoWhere, [relativePath, rawPath], userId ?? undefined);

    // Fallbacks: DOC_EXTENSIONS (.mdx, .rst, .adoc, .tex, etc.), README.md, README.mdx, index.md, index.mdx
    if (!doc && relativePath.endsWith('.md')) {
      const basePath = relativePath.slice(0, -3);
      const candidatePaths = ['.mdx', '.rst', '.adoc', '.tex', '.txt', '.markdown'].map((ext) => `${basePath}${ext}`);
      doc = await findVisibleDoc(repoWhere, candidatePaths, userId ?? undefined);
    }
    if (!doc && slug && slug.length > 0) {
      const slugPrefix = slug.join('/');
      const slugCandidates = [
        `${slugPrefix}/README.md`,
        `${slugPrefix}/README.mdx`,
        `${slugPrefix}/index.md`,
        `${slugPrefix}/index.mdx`,
      ];
      doc = await findVisibleDoc(repoWhere, slugCandidates, userId ?? undefined);
    }

    // Fallback: 激活大纲按 docPath 反查
    if (!doc) {
      const outline = await getOutline();
      if (outline) {
        const matchedPath = resolveDocPathFromOutline(outline, rawPath);
        if (matchedPath) {
          doc = await findVisibleDoc(repoWhere, [matchedPath], userId ?? undefined);
        }
      }
    }

    // Fallback: navTree (优先从大纲纯函数投影，无大纲回退 repository.navTree)
    if (!doc) {
      const outline = await getOutline();
      const navNodes = await resolveEffectiveNavTree(repository.id, {
        owner,
        repo,
        outline,
        fallbackNavTree: repository.navTree,
      });
      if (navNodes.length > 0) {
        const findNavNode = (nodes: any[]): any | null => {
          for (const node of nodes) {
            if (!node) continue;
            if (node.url && (node.url.endsWith(`/${rawPath}`) || node.name === rawPath)) {
              return node;
            }
            if (node.children) {
              const found = findNavNode(node.children);
              if (found) return found;
            }
          }
          return null;
        };
        const matchedNode = findNavNode(navNodes);
        if (matchedNode && matchedNode.path) {
          doc = await findVisibleDoc(repoWhere, [matchedNode.path], userId ?? undefined);
        }
      }
    }
  }

  // ── 内容寻址读切换 ──
  if (doc) {
    doc = applyContentLayerRead(doc);
  }

  // ── Zero-Materialization: 动态 API Reference 虚拟文档投影 ──
  if (!doc) {
    const profile = (repository.repoProfile as Record<string, unknown> | null) ?? {};
    const normRaw = (rawPath || '').toLowerCase().replace(/^\/+|\/+$/g, '');
    if (
      (normRaw === 'api-reference' || normRaw === 'api' || normRaw === 'openapi') &&
      (profile.hasOpenApi || profile.openApiUrl)
    ) {
      const apiTitle = (profile.openApiTitle as string) || 'API Reference';
      doc = {
        id: `virtual-api-${repository.id}`,
        repositoryId: repository.id,
        path: 'api-reference.md',
        title: apiTitle,
        content: `# ${apiTitle}\n\nOpenAPI 规范驱动的 1:1 双栏交互式参考视窗。`,
        contentId: null,
        ownerUserId: null,
        status: 'PROCESSED',
        generationLevel: 1,
        repository,
        isVirtual: true,
      };
      relativePath = 'api-reference.md';
    }
  }

  // 如果未找到文档，检查根目录重定向
  if (!doc) {
    const outline = await getOutline();

    // 访问根路径时的自动重定向（严禁重定向至当前根路径或 /index，杜绝死循环）
    if (!slug || slug.length === 0) {
      const redirect = await resolveRootNavRedirect(owner, repo, editionQuery, repository, outline);
      const currentRequestedPath = `/docs/${owner}/${repo}${editionQuery}`.toLowerCase();
      const redirectLower = (redirect?.url || '').toLowerCase();
      if (
        redirect &&
        redirectLower !== currentRequestedPath &&
        redirectLower !== `${currentRequestedPath}/index` &&
        redirectLower !== `${currentRequestedPath}/readme`
      ) {
        return redirect;
      }
    }

    // 跨版本切换容错（ReaderActor Decoupling）：若读者切换讲法，
    // 但原讲法的 slug 在目标讲法拓扑中不存在，平滑重定向至目标讲法的首章，避免 404 突兀打断阅读
    const currentRequestedPath = `/docs/${owner}/${repo}${rawPath ? `/${rawPath}` : ''}${editionQuery}`;
    if (editionQuery) {
      const redirect = await resolveRootNavRedirect(owner, repo, editionQuery, repository, outline);
      if (redirect && redirect.url !== currentRequestedPath) {
        return redirect;
      }
    } else {
      // 读者从衍生讲法切回默认讲法（未带 ?edition=）时，若当前 slug 属于该仓其他讲法，
      // 平滑重定向至默认讲法首章，避免 404 突兀打断阅读。
      // 仅做可走 B-tree 前缀索引的精确匹配：后缀通配（endsWith）既无法用索引
      // （公开路由 Bot 流量逐 miss 全扫），又制造假阳性软 404（slug '01' 命中任意 '*/01.md'）
      const rawSlug = Array.isArray(slug) ? slug.join('/') : (slug || '');
      const otherEditionDoc = rawSlug
        ? await prisma.document.findFirst({
            where: {
              repository: {
                owner: { equals: owner, mode: 'insensitive' },
                repo: { equals: repo, mode: 'insensitive' },
              },
              OR: [
                { path: rawSlug },
                { path: `${rawSlug}.md` },
                { path: `${rawSlug}.mdx` },
              ],
            },
            select: { id: true },
          })
        : null;
      if (otherEditionDoc) {
        const redirect = await resolveRootNavRedirect(owner, repo, '', repository, outline);
        if (redirect && redirect.url !== currentRequestedPath) {
          return redirect;
        }
      }
    }

    return { type: 'not-found' };
  }

  // Update reading bookmark
  // 【受控例外 #3 · 读路径显式写】「读到哪」锚点 upsert：请求级 memo 保证单请求恰好写一次
  // （lastReadPath 覆盖写，幂等）；登记于 lib/state/README.md §四
  // 虚拟文档（isVirtual）严格短路，严禁污染用户真实阅读书签（避免锁死 API 视窗）
  if (userId && prisma.userReadingProgress && !(doc as { isVirtual?: boolean }).isVirtual) {
    try {
      await prisma.userReadingProgress.upsert({
        where: { userId_repositoryId: { userId, repositoryId: repository.id } },
        update: { lastReadPath: doc.path },
        create: { userId, repositoryId: repository.id, lastReadPath: doc.path },
      });
    } catch (e) {
      console.warn('[DocsPageLoader] Failed to update reading bookmark:', e);
    }
  }

  const isPublic = !!doc.repository?.isPublic;
  const hasRepoProfile = !!doc.repository?.repoProfile;

  // 关联信息异步并行拉取：仓级只读元数据走 60s LRU 内存缓存，当前章节的 ChapterVersion、
  // UpdateJob 与认知脚手架 grounding 全部并行（grounding 原在版本解析后串行 await，
  // 其 1.5s 超时预算直接叠加进页面关键路径；sha 键结果不可变经 driver 层缓存二次免打）
  const loadScaffold = async (): Promise<DocCognitiveScaffold | null> => {
    if (!doc?.path) return null;
    const { subsystemName, subsystemDuty } = inferDocSubsystem(doc.path, doc.title);

    let backboneFiles: Array<{ path: string; role: string; pageRank: number }> = [];
    const gitSha = repository?.gitSha || doc.repository?.gitSha;
    if (gitSha) {
      try {
        const grounding = await executeSidecarConceptGrounding({
          owner,
          repo,
          sha: gitSha,
          conceptName: subsystemName,
          timeoutMs: 1500,
        });
        if (grounding?.backboneFiles && grounding.backboneFiles.length > 0) {
          const subsystemLower = subsystemName.toLowerCase();
          const matched = grounding.backboneFiles.filter((f) =>
            f.path.toLowerCase().includes(subsystemLower)
          );
          backboneFiles = (matched.length > 0 ? matched : grounding.backboneFiles).slice(0, 4);
        }
      } catch {
        backboneFiles = [];
      }
    }

    return { subsystemName, subsystemDuty, backboneFiles };
  };

  const isVirtualDoc = Boolean((doc as { isVirtual?: boolean }).isVirtual);

  const [repoMeta, versionData, activeUpdateJob, cognitiveScaffold] = await Promise.all([
    fetchRepoDocPageMetadata(doc.repositoryId, owner, repo, isPublic, hasRepoProfile),
    isVirtualDoc
      ? Promise.resolve({
          chapterVersions: [],
          viewerVersionVotes: new Set<string>(),
          validContentIds: new Set<string>(),
          inlineContentById: new Map(),
        })
      : loadChapterVersionsWithContent(doc.id, userId ?? undefined),
    isVirtualDoc
      ? Promise.resolve(null)
      : prisma.chapterUpdateJob.findFirst({
          where: { documentId: doc.id, status: { in: ['PENDING', 'CLAIMED', 'TRIAL'] } },
          select: { id: true, status: true, kind: true, frozenCredits: true, voteDeadline: true, claimedBy: true },
          orderBy: { createdAt: 'asc' },
        }).catch((e) => {
          // 容错降级: 章节更新任务查询失败时不阻断正文主页面渲染
          console.warn('[DocsPageLoader] Failed to fetch active chapter update job:', e);
          return null;
        }),
    isVirtualDoc ? Promise.resolve(null) : loadScaffold(),
  ]);

  const { chapterVersions, viewerVersionVotes, validContentIds, inlineContentById } = versionData;
  const { syncHistory, maintainerId, unprocessedCount } = repoMeta;
  const showAutoSyncSwitch = !!userId && maintainerId === userId;

  const { activeVersion, sanitizedVersions, hasFallback } = resolveEffectiveChapterVersion(
    chapterVersions,
    { versionParam, userId, validContentIds }
  );

  if (activeVersion?.contentId && validContentIds.has(activeVersion.contentId)) {
    // 两段式：sidecar 已带回正文则直接用；Prisma 回退路径按生效版本单独取一份
    const inline = inlineContentById?.get(activeVersion.contentId);
    const activeContent =
      inline !== undefined ? inline : await fetchActiveVersionContentById(activeVersion.contentId);
    if (activeContent) {
      doc = { ...doc, content: activeContent };
    }
  } else if (hasFallback) {
    console.warn(
      `[DocsPageLoader] Version corrupted or fallback applied for doc=${doc.id}, requestedParam=${versionParam}`
    );
  }

  if (!doc) {
    return { type: 'not-found' };
  }
  const currentDoc = doc;

  const repoProfile = (currentDoc.repository?.repoProfile || repoMeta.repoProfile || null) as Record<string, any> | null;

  // 通用章节资产解析中间件：v2 画像走 chapterMap（mainPath 命中即章节正文页，
  // 资产页按归属章节命中）；旧落库画像回退 legacy chapterAssets 路径段匹配
  let chapterAssets: ChapterAsset[] | null = null;
  if (repoProfile && typeof repoProfile === 'object' && currentDoc.path) {
    const chapterMap = (repoProfile as { chapterMap?: ChapterMapEntry[] }).chapterMap;
    if (Array.isArray(chapterMap) && chapterMap.length > 0) {
      const entry =
        chapterMap.find((e) => e.mainPath === currentDoc.path) ??
        chapterMap.find((e) => (e.assetPaths || []).some((a) => a.path === currentDoc.path));
      if (entry && entry.assetPaths && entry.assetPaths.length > 0) {
        chapterAssets = entry.assetPaths.map((a) => ({
          path: a.path,
          type: (a.kind || 'resource').toUpperCase(),
          // 附页资产是仓库相对路径，消费端按外链打开——在此组装绝对 blob URL
          downloadUrl: buildRepoAssetUrl(owner, repo, currentDoc.repository?.branch, a.path),
        }));
      }
    } else if (repoProfile.chapterAssets && currentDoc.path) {
      // legacy v1 画像（key 为 `chapterN` 归一名）：按路径段精确匹配
      const rawChapterAssets = repoProfile.chapterAssets as Record<string, ChapterAsset[]>;
      const pathSegments = currentDoc.path.split('/').filter(Boolean);
      for (const seg of pathSegments) {
        if (rawChapterAssets[seg] && rawChapterAssets[seg].length > 0) {
          chapterAssets = rawChapterAssets[seg].map((a) => ({
            ...a,
            downloadUrl: a.downloadUrl || buildRepoAssetUrl(owner, repo, currentDoc.repository?.branch, a.path),
          }));
          break;
        }
      }
    }
  }

  // ── 认知脚手架：已在主 Promise.all 并行装配完成（sha 键 grounding 结果
  // 经 driver 层不可变缓存，同 commit 同概念进程内只打一次 sidecar）──
  if (cognitiveScaffold) {
    doc = { ...doc, cognitiveScaffold } as any;
  }

  return {
    type: 'doc',
    repository,
    doc,
    relativePath,
    rawPath,
    syncHistory,
    showAutoSyncSwitch,
    unprocessedCount,
    chapterVersions: sanitizedVersions,
    viewerVersionVotes,
    activeVersion,
    activeUpdateJob,
    repoProfile,
    chapterAssets,
    editionFallback,
    cognitiveScaffold,
  };
}

// ── 请求级去重：generateMetadata 与 Page 各调用一次相同参数的 loadDocPageData，
// 完整管线（resolver/findVisibleDoc 级联/章节版本/sidecar grounding/阅读书签 upsert）
// 会被执行两遍。cache() 提供请求作用域（react-server 构建下真实 memo；纯 react
// 环境透传退化，不影响正确性）；参数对象字面量按 Object.is 比较永不命中，故由
// 基元序列化稳定 key 索引。失败即删除条目——metadata 阶段的失败不被 memo 污染，
// Page 的调用可重新执行（保留瞬时错误重试语义）。同请求内阅读书签 upsert 恰好写一次
// （lastReadPath 覆盖写，语义等价）。 ──
const getDocPageRequestCache = cache(() => new Map<string, Promise<DocPageResolution>>());

function docPageRequestCacheKey(o: LoadDocPageOptions): string {
  return JSON.stringify([
    o.owner,
    o.repo,
    o.slug ?? null,
    o.version ?? null,
    o.branch ?? null,
    o.edition ?? null,
    o.versionParam ?? null,
    o.userId ?? null,
  ]);
}

/**
 * 稳定 key + 失败删除的请求内 memo 组合（导出为纯函数便于单测锁定语义）：
 * 命中共享同一 Promise；未命中执行 loader 并登记；loader 失败即从 store 删除，
 * 后续调用重新执行。
 */
export function withRequestMemo<T>(
  store: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  let p = store.get(key);
  if (!p) {
    p = load().catch((err) => {
      store.delete(key);
      throw err;
    });
    store.set(key, p);
  }
  return p;
}

export function loadDocPageDataCached(options: LoadDocPageOptions): Promise<DocPageResolution> {
  return withRequestMemo(getDocPageRequestCache(), docPageRequestCacheKey(options), () =>
    loadDocPageData(options)
  );
}

async function resolveLastReadRedirect(
  userId: string | null | undefined,
  repositoryId: string,
  owner: string,
  repo: string,
  editionQuery: string
): Promise<{ type: 'redirect'; url: string } | null> {
  if (!userId) return null;
  try {
    const userProgress = await prisma.userReadingProgress.findUnique({
      where: {
        userId_repositoryId: { userId, repositoryId },
      },
      select: { lastReadPath: true },
    });
    if (!userProgress?.lastReadPath) return null;

    let targetSlug = docPathToSlug(userProgress.lastReadPath);
    const lower = targetSlug.toLowerCase();
    if (lower === 'readme' || lower === 'index') {
      targetSlug = '';
    } else if (lower.endsWith('/readme')) {
      targetSlug = targetSlug.substring(0, targetSlug.length - 7);
    } else if (lower.endsWith('/index')) {
      targetSlug = targetSlug.substring(0, targetSlug.length - 6);
    }
    if (targetSlug) {
      return { type: 'redirect', url: `/docs/${owner}/${repo}/${targetSlug}${editionQuery}` };
    }
  } catch (e) {
    console.warn('[DocsPageLoader] Failed to fetch lastReadPath for redirect:', e);
  }
  return null;
}

async function resolveRootNavRedirect(
  owner: string,
  repo: string,
  editionQuery: string,
  repository: { id: string; navTree?: any },
  outline: any
): Promise<{ type: 'redirect'; url: string } | null> {
  if (outline) {
    const firstNode = firstNavigableNode(outline);
    if (firstNode?.docPath) {
      return { type: 'redirect', url: `${outlineNodeUrl(owner, repo, firstNode.docPath)}${editionQuery}` };
    }
  }

  const fallbackNodes = await resolveEffectiveNavTree(repository.id, {
    owner,
    repo,
    outline,
    fallbackNavTree: repository.navTree,
  });
  if (fallbackNodes.length === 0) {
    return null;
  }

  const firstUrl = findFirstNavFileUrl(fallbackNodes, owner, repo);
  if (!firstUrl) {
    return null;
  }

  return { type: 'redirect', url: `${firstUrl}${editionQuery}` };
}

function findFirstNavFileUrl(nodes: any[], owner: string, repo: string): string | null {
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path) {
        const clean = node.path.replace(/\.mdx?$/i, '');
        const lower = clean.toLowerCase();
        if (lower === 'index' || lower === 'readme') {
          return `/docs/${owner}/${repo}`;
        }
        if (lower.endsWith('/index') || lower.endsWith('/readme')) {
          const parent = clean.slice(0, clean.lastIndexOf('/'));
          return `/docs/${owner}/${repo}/${parent}`;
        }
        return `/docs/${owner}/${repo}/${clean}`;
      }
      if (node.url && !/^https?:\/\//i.test(node.url)) {
        return node.url;
      }
    }
    if (node.children) {
      const url = findFirstNavFileUrl(node.children, owner, repo);
      if (url) return url;
    }
  }
  return null;
}

/**
 * 章节多版本加载与正文完整性校验：
 * 优先走 Go worker-sidecar 原生联查（POST /v1/chapter-versions/list），
 * 杜绝原 Node 端 3 次 Prisma 往返与内存二次拼装；若未启用则无缝回退 Prisma 查询。
 *
 * 正文获取两段式（性能修复 2026-10-13）：仅返回「有效 contentId 集合」用于版本
 * 完整性判定；正文在 resolveEffectiveChapterVersion 选出生效版本后单独取——
 * sidecar 路径联查已带回正文（inlineContentById 零额外成本直接复用），Prisma
 * 回退路径不再预取全部版本正文（原先把所有 ChapterVersion 的完整 MDX 拉回，
 * 实际只消费 activeVersion 一份）。
 */
/** 章节版本联查微缓存：10s TTL 削减同章翻页/多读者的 sidecar 扇出（失败与回退路径不缓存） */
const chapterVersionsMicrocache = createTtlMicroCache<Awaited<ReturnType<typeof loadChapterVersionsWithContent>>>(
  10_000,
  500
);

async function loadChapterVersionsWithContent(docId: string, userId?: string): Promise<{
  chapterVersions: ChapterVersionSummary[];
  viewerVersionVotes: Set<string>;
  validContentIds: Set<string>;
  /** sidecar 联查顺带回传的正文（contentId → content）；Prisma 回退路径为 null */
  inlineContentById: Map<string, string> | null;
}> {
  // 匿名读者共享 'anon' 键（公共版本面）；登录用户按 userId 隔离（私有版本可见性）
  const cacheKey = `${docId}:${userId ?? 'anon'}`;
  const cachedResult = chapterVersionsMicrocache.get(cacheKey);
  if (cachedResult) return cachedResult;

  try {
    const { callSidecar } = await import('@/lib/sidecar-client');
    const res = await callSidecar<{
      ok: boolean;
      versions?: Array<{
        id: string;
        authorId: string;
        voteCount: number;
        isCanonical: boolean;
        visibility: string;
        source: string;
        createdAt: string;
        contentId?: string;
        author: { name?: string | null; image?: string | null };
        hasVoted: boolean;
        isContentValid: boolean;
        content?: string;
      }>;
    }>(
      '/v1/chapter-versions/list',
      { documentId: docId, userId: userId ?? undefined },
      { label: 'chapter-versions-list /v1/chapter-versions/list', timeoutMs: 3_000 }
    );

    if (res.ok && res.versions) {
      const chapterVersions = res.versions.map((v) => ({
        id: v.id,
        authorId: v.authorId,
        voteCount: v.voteCount,
        isCanonical: v.isCanonical,
        visibility: v.visibility,
        source: v.source,
        createdAt: new Date(v.createdAt),
        contentId: v.contentId ?? null,
        author: {
          name: v.author?.name ?? null,
          image: v.author?.image ?? null,
        },
      }));

      const viewerVersionVotes = new Set<string>(
        res.versions.filter((v) => v.hasVoted).map((v) => v.id)
      );

      const inlineContentById = new Map<string, string>();
      for (const v of res.versions) {
        if (v.isContentValid && v.contentId && v.content) {
          inlineContentById.set(v.contentId, v.content);
        }
      }

      const result = {
        chapterVersions,
        viewerVersionVotes,
        validContentIds: new Set(inlineContentById.keys()),
        inlineContentById,
      };
      chapterVersionsMicrocache.set(cacheKey, result);
      return result;
    }
  } catch {
    // 降级回退原有 Prisma 查法
  }

  // Fallback: 3 次 Prisma 串行/并发查询
  const chapterVersions = await prisma.chapterVersion
    .findMany({
      where: { documentId: docId, OR: [{ visibility: 'PUBLIC' }, ...(userId ? [{ authorId: userId }] : [])] },
      select: {
        id: true,
        authorId: true,
        voteCount: true,
        isCanonical: true,
        visibility: true,
        source: true,
        createdAt: true,
        contentId: true,
        author: { select: { name: true, image: true } },
      },
      orderBy: [{ isCanonical: 'desc' }, { voteCount: 'desc' }, { createdAt: 'desc' }],
    })
    .catch(() => []);

  const viewerVersionVotes =
    userId && chapterVersions.length > 0
      ? new Set(
          (
            await prisma.chapterVersionVote
              .findMany({
                where: { userId, versionId: { in: chapterVersions.map((cv) => cv.id) } },
                select: { versionId: true },
              })
              .catch(() => [])
          ).map((x) => x.versionId)
        )
      : new Set<string>();

  const contentIds = Array.from(
    new Set(chapterVersions.map((cv) => cv.contentId).filter((id): id is string => Boolean(id)))
  );

  // 有效性判定只验存在性与非空（与旧全量预取的 falsy 过滤语义一致），不拉正文
  const validRows =
    contentIds.length > 0
      ? await prisma.documentContent
          .findMany({
            where: { id: { in: contentIds }, NOT: [{ content: null }, { content: '' }] },
            select: { id: true },
          })
          .catch(() => [])
      : [];

  return {
    chapterVersions,
    viewerVersionVotes,
    validContentIds: new Set(validRows.map((r) => r.id)),
    inlineContentById: null,
  };
}

/** 两段式第二段：按生效版本的 contentId 取唯一一份正文（行被并发删除时安全返回 null） */
async function fetchActiveVersionContentById(contentId: string): Promise<string | null> {
  try {
    const row = await prisma.documentContent.findUnique({
      where: { id: contentId },
      select: { content: true },
    });
    return row?.content || null;
  } catch {
    return null;
  }
}


