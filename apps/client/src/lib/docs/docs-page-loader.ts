import { cache } from 'react';
import { ignoreBestEffort } from '@/lib/best-effort';
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
import { hasCorruptionMarker } from '@/lib/constants';
import { isWebDocRepository } from '@/lib/repository-resolver';
import { getWebL1OutlineProjection, getWebL1OutlineProjectionById } from './web-outline-projection';
import { createTtlMicroCache } from './ttl-microcache';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';

// Repo-relative assets must expand to GitHub blob URLs so the app router does not treat them as 404 routes.
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
      editionFallback?: { requestedEdition: string };
      cognitiveScaffold?: DocCognitiveScaffold | null;
      activeOutline?: OutlineView | null;
    };

export interface CachedRepoDocPageMetadata {
  syncHistory: any[];
  maintainerId: string | null;
  unprocessedCount: number;
  repoProfile?: Record<string, any> | null;
}

const REPO_DOC_PAGE_META_TTL_MS = 60_000;
const repoPageMetaCache = new Map<string, { data: CachedRepoDocPageMetadata; expiresAt: number }>();

const PUBLIC_DOC_PAGE_TTL_MS = 60_000;
const publicDocPageCache = createTtlMicroCache<Extract<DocPageResolution, { type: 'doc' }>>(
  PUBLIC_DOC_PAGE_TTL_MS,
  256
);

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
    }).catch(() => { ignoreBestEffort(); return []; }),

    isPublic ? resolveMaintainerUserId(repositoryId).catch(() => { ignoreBestEffort(); return null; }) : null,

    !isPublic
      ? prisma.document.count({ where: { repositoryId, ownerUserId: null, status: 'UNPROCESSED' } }).catch(() => { ignoreBestEffort(); return 0; })
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

export function clearPublicDocPageCacheForTest() {
  publicDocPageCache.clear();
}

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
  const editionQuery = edition ? `?edition=${encodeURIComponent(edition)}` : '';

  let resolved: Awaited<ReturnType<typeof resolveRepository>> | null = null;
  let repository: any = null;
  let outlineCache: OutlineView | null | undefined = undefined;

  if (!version && !branch) {
    const l1Hit = await getWebL1OutlineProjection(owner, repo, edition);
    if (l1Hit && l1Hit.repoSnapshot.isPublic) {
      if (edition && l1Hit.edition.toLowerCase() !== edition.toLowerCase()) {
        const slugPath = slug && slug.length > 0 ? `/${slug.join('/')}` : '';
        return { type: 'redirect', url: `/docs/${owner}/${repo}${slugPath}` };
      }
      repository = { ...l1Hit.repoSnapshot, gitSha: l1Hit.gitSha };
      if (l1Hit.outline && l1Hit.outline.outlineId) {
        outlineCache = l1Hit.outline;
      }
    }
  }

  if (!repository) {
    resolved = await resolveRepository(owner, repo, version || branch, edition);
    repository = resolved?.repository;

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
  }

  const publicCacheKey =
    !userId && repository?.isPublic && !version && !branch
      ? `${repository.id}:${(slug || []).join('/')}:${versionParam ?? ''}:${edition ?? ''}`
      : null;
  if (publicCacheKey) {
    const cachedPublicDoc = publicDocPageCache.get(publicCacheKey);
    if (cachedPublicDoc) {
      return cachedPublicDoc;
    }
  }

  // Never silently swap an explicitly requested ?edition= to another edition on private access mismatch.
  if (!edition && repository && !repository.isPublic && !(await verifyRepoAccessDirect(repository, userId ?? undefined))) {
    const publicRow = await findPublicGroupRow(owner, repo).catch(() => { ignoreBestEffort(); return null; });
    if (publicRow) {
      repository = publicRow;
    }
  }

  if (!repository) {
    return { type: 'not-found' };
  }

  // 307 strips stale ?edition= so the URL bar and cache reflect the resolved edition.
  if (edition && resolved?.editionMiss) {
    const slugPath = slug && slug.length > 0 ? `/${slug.join('/')}` : '';
    return { type: 'redirect', url: `/docs/${owner}/${repo}${slugPath}` };
  }

  const editionFallback =
    edition && resolved && (resolved.resolvedEdition ?? '') !== edition
      ? { requestedEdition: edition }
      : undefined;

  const rawPath = slug ? slug.join('/') : '';

  // 301 canonicalizes /index and /readme variants to prevent duplicate URL caching.
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

  if (!slug || slug.length === 0) {
    const lastReadRedirect = await resolveLastReadRedirect(userId, repository.id, owner, repo, editionQuery);
    if (lastReadRedirect) {
      return lastReadRedirect;
    }
  }

  let doc: any = null;
  if (!rawPath) {
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

    if (!doc) {
      const outline = await getOutline();
      if (outline) {
        const matchedPath = resolveDocPathFromOutline(outline, rawPath);
        if (matchedPath) {
          doc = await findVisibleDoc(repoWhere, [matchedPath], userId ?? undefined);
        }
      }
    }

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

  if (doc) {
    doc = applyContentLayerRead(doc);
  }

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

  if (!doc) {
    const outline = await getOutline();

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

    const currentRequestedPath = `/docs/${owner}/${repo}${rawPath ? `/${rawPath}` : ''}${editionQuery}`;
    if (editionQuery) {
      const redirect = await resolveRootNavRedirect(owner, repo, editionQuery, repository, outline);
      if (redirect && redirect.url !== currentRequestedPath) {
        return redirect;
      }
    } else {
      // Prefix match only: suffix wildcards bypass B-tree indexes and cause false cross-edition redirects.
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

  // Never persist reading bookmarks for virtual API reference docs.
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

  const isVirtualDoc = Boolean((doc as { isVirtual?: boolean }).isVirtual);

  const [repoMeta, versionData, activeUpdateJob] = await Promise.all([
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
          console.warn('[DocsPageLoader] Failed to fetch active chapter update job:', e);
          return null;
        }),
  ]);

  const { chapterVersions, viewerVersionVotes, validContentIds, inlineContentById } = versionData;
  const { syncHistory, maintainerId, unprocessedCount } = repoMeta;
  const showAutoSyncSwitch = !!userId && maintainerId === userId;

  const { activeVersion, sanitizedVersions, hasFallback } = resolveEffectiveChapterVersion(
    chapterVersions,
    { versionParam, userId, validContentIds }
  );

  if (activeVersion?.contentId && validContentIds.has(activeVersion.contentId)) {
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
          downloadUrl: buildRepoAssetUrl(owner, repo, currentDoc.repository?.branch, a.path),
        }));
      }
    } else if (repoProfile.chapterAssets && currentDoc.path) {
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

  const result: Extract<DocPageResolution, { type: 'doc' }> = {
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
    cognitiveScaffold: null,
    activeOutline: outlineCache,
  };

  if (publicCacheKey && doc.content && !hasCorruptionMarker(doc.content)) {
    publicDocPageCache.set(publicCacheKey, result);
  }

  return result;
}

// Request-scoped memo deduplicates generateMetadata + Page calls and evicts failures so Page retries transient errors.
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

// Fetch only valid contentId metadata here; fetchActiveVersionContentById loads only the winning active version body.
const chapterVersionsMicrocache = createTtlMicroCache<Awaited<ReturnType<typeof loadChapterVersionsWithContent>>>(
  10_000,
  500
);

async function loadChapterVersionsWithContent(docId: string, userId?: string): Promise<{
  chapterVersions: ChapterVersionSummary[];
  viewerVersionVotes: Set<string>;
  validContentIds: Set<string>;
  inlineContentById: Map<string, string> | null;
}> {
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
    ignoreBestEffort();
  }

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
    .catch(() => { ignoreBestEffort(); return []; });

  const viewerVersionVotes =
    userId && chapterVersions.length > 0
      ? new Set(
          (
            await prisma.chapterVersionVote
              .findMany({
                where: { userId, versionId: { in: chapterVersions.map((cv) => cv.id) } },
                select: { versionId: true },
              })
              .catch(() => { ignoreBestEffort(); return []; })
          ).map((x) => x.versionId)
        )
      : new Set<string>();

  const contentIds = Array.from(
    new Set(chapterVersions.map((cv) => cv.contentId).filter((id): id is string => Boolean(id)))
  );

  const validRows =
    contentIds.length > 0
      ? await prisma.documentContent
          .findMany({
            where: { id: { in: contentIds }, NOT: [{ content: null }, { content: '' }] },
            select: { id: true },
          })
          .catch(() => { ignoreBestEffort(); return []; })
      : [];

  return {
    chapterVersions,
    viewerVersionVotes,
    validContentIds: new Set(validRows.map((r) => r.id)),
    inlineContentById: null,
  };
}

async function fetchActiveVersionContentById(contentId: string): Promise<string | null> {
  try {
    const row = await prisma.documentContent.findUnique({
      where: { id: contentId },
      select: { content: true },
    });
    return row?.content || null;
  } catch {
    ignoreBestEffort();
    return null;
  }
}

