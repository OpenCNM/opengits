import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { DocsPage, DocsBody, DocsTitle } from 'fumadocs-ui/page';
import React from 'react';
import * as m from '@/paraglide/messages';
import { getSessionHelper } from '@/lib/auth-helper';
import { CLOUD_URL } from '@/lib/constants';
import { getBaseUrl } from '@/lib/url-utils';
import { prisma } from '@/lib/db';
import { DocumentProvider } from '@/components/mdx/DocumentContext';
import { ScrollRestorer } from '@/components/telemetry/ScrollRestorer';
import { UpstreamUpdateToast } from '@/components/update/UpstreamUpdateToast';
import { ChapterUpdateCapsule, type ActiveUpdateJob } from '@/components/update/ChapterUpdateCapsule';
import { ChapterVersionSwitcher, ChapterFeedbackCard } from '@/components/update/ChapterVersionSwitcher';
import { SyncHistoryList } from '@/components/update/SyncHistoryList';
// 编译失败兜底渲染器懒加载（性能修复 2026-10-13）：react-markdown + rehype-raw +
// rehype-sanitize 随兜底路径静态进入主 chunk；正常路径永不渲染——dynamic 拆分后
// 仅在编译失败时拉取
const GfmFallbackRenderer = dynamic(() => import('@/components/mdx/GfmFallbackRenderer'));
const ScalarApiViewer = dynamic(() => import('@/components/api-reference/ScalarApiViewer'));
import MicroQuiz from '@/components/mdx/MicroQuiz';
import { ChapterFoldout } from '@/components/mdx/ChapterFoldout';
import { buildDocCustomComponents, compileDocMdx } from '@/components/docs/docs-mdx-runtime';
import { ComponentErrorBoundary } from '@/components/ui/ComponentErrorBoundary';
import { loadDocPageDataCached } from '@/lib/docs/docs-page-loader';
import { adjacentNavigableNodes, outlineNodeUrl } from '@/lib/outline-reader';
import { hasCorruptionMarker } from '@/lib/constants';
import { ChapterPrevNextNav } from '@/components/docs/ChapterPrevNextNav';
import { CodeDrawer } from '@/components/docs/CodeDrawer';
import { ChapterShareButton } from '@/components/docs/ChapterShareButton';
import { GenerationLevelBadge } from '@/components/docs/GenerationLevelBadge';
import { ChapterDegradedNotice } from '@/components/docs/ChapterDegradedNotice';
import { GuestShelfJoinCallout } from '@/components/docs/GuestShelfJoinCallout';
import { isNativeWebDocMirror, isWebDocRepository } from '@/lib/repository-origin';
import { buildWebDocLinkContext } from '@/lib/docs/webdoc-href-resolver';
import type { OutlineView } from '@/lib/outline-reader';

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; repo: string; slug?: string[] }>;
  searchParams: Promise<{ version?: string; branch?: string; edition?: string; v?: string }>;
}): Promise<Metadata> {
  const { owner, repo, slug } = await params;
  const { version, branch, edition, v: versionParam } = await searchParams;

  const session = await getSessionHelper();
  const userId = session?.user?.id;

  const resolved = await loadDocPageDataCached({
    owner,
    repo,
    slug,
    version,
    branch,
    edition,
    versionParam,
    userId,
  }).catch(() => null);

  if (!resolved || resolved.type !== 'doc') {
    return {
      title: `${repo} | OpenGits`,
    };
  }

  const { doc, repository } = resolved;
  const title = doc.title || (slug && slug.length > 0 ? slug[slug.length - 1] : repo);
  const repoName = `${owner}/${repo}`;
  const baseUrl = getBaseUrl();
  const canonicalPath = `/docs/${owner}/${repo}${slug && slug.length > 0 ? `/${slug.join('/')}` : ''}`;
  const canonicalUrl = `${baseUrl}${canonicalPath}`;

  // 优先读取高质量确定性事实（数据库结构化 summary），无摘要时安全规避跨行多正则
  const description = doc.summary?.trim()
    ? doc.summary.trim().slice(0, 160)
    : doc.content
        ? doc.content
            .replace(/^---[\s\S]*?---\n?/, '')
            .replace(/<[^>]+>/g, '')
            .replace(/#+\s+.*?\n/g, '')
            .replace(/[`*_[\]()]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160)
        : `${title} — ${repoName} interactive tutorial on OpenGits`;

  const ogUrl = new URL('/api/og', baseUrl);
  ogUrl.searchParams.set('owner', owner);
  ogUrl.searchParams.set('repo', repo);
  ogUrl.searchParams.set('title', title);
  const model = repository?.transcriptionModels?.[0];
  if (model) {
    ogUrl.searchParams.set('model', model);
  }

  return {
    title: `${title} — ${repoName} | OpenGits`,
    description,
    metadataBase: new URL(baseUrl),
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: `${title} — ${repoName}`,
      description,
      url: canonicalUrl,
      type: 'article',
      siteName: 'OpenGits',
      images: [
        {
          url: ogUrl.toString(),
          width: 1200,
          height: 630,
          alt: `${title} — ${repoName}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} — ${repoName}`,
      description,
      images: [ogUrl.toString()],
    },
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; repo: string; slug?: string[] }>;
  searchParams: Promise<{ version?: string; branch?: string; edition?: string; v?: string }>;
}) {
  const { owner, repo, slug } = await params;
  const { version, branch, edition, v: versionParam } = await searchParams;

  const session = await getSessionHelper();
  const userId = session?.user?.id;

  const resolved = await loadDocPageDataCached({
    owner,
    repo,
    slug,
    version,
    branch,
    edition,
    versionParam,
    userId,
  });

  if (resolved.type === 'not-found') {
    notFound();
  }

  if (resolved.type === 'redirect') {
    redirect(resolved.url);
  }

  const {
    repository,
    doc,
    relativePath,
    syncHistory,
    showAutoSyncSwitch,
    chapterVersions,
    viewerVersionVotes,
    activeVersion,
    activeUpdateJob,
    repoProfile,
    chapterAssets,
    editionFallback,
  } = resolved;

  const isNativeWebMirror = isNativeWebDocMirror({
    owner,
    repo,
    repoProfile,
    edition: repository?.edition ?? doc.repository?.edition,
  });

  const profile = (repoProfile as Record<string, unknown> | null) ?? {};
  const hasOpenApi = Boolean(profile.hasOpenApi || profile.openApiUrl);
  const isApiDoc = Boolean(
    hasOpenApi && (
      doc.path === 'api-reference.md' ||
      (doc as unknown as { isVirtual?: boolean }).isVirtual === true
    )
  );
  const openApiProxyUrl = hasOpenApi ? `/api/repos/${owner}/${repo}/openapi` : undefined;

  // JIT (Just-In-Time) Processing Strategy
  if (!doc.content || hasCorruptionMarker(doc.content)) {
    // 接力仓的共享章节：统一等待/招募页
    if (doc.repository?.relayEnabled && doc.ownerUserId === null) {
      const { getActiveOutline, allChaptersInTeachingOrder } = await import('@/lib/outline-reader');
      const activeOutline = await getActiveOutline(doc.repositoryId).catch(() => null);

      let chapterTotal: number;
      let bakedCount: number;

      if (activeOutline) {
        const allNodes = allChaptersInTeachingOrder(activeOutline).flatMap((ch) => ch.nodes);
        chapterTotal = allNodes.length;
        bakedCount = allNodes.filter((n) => n.docStatus === 'PROCESSED').length;
      } else {
        const [rawTotal, rawBaked] = await Promise.all([
          prisma.document.count({ where: { repositoryId: doc.repositoryId, ownerUserId: null } }),
          prisma.document.count({ where: { repositoryId: doc.repositoryId, ownerUserId: null, status: 'PROCESSED' } }),
        ]);
        chapterTotal = rawTotal;
        bakedCount = rawBaked;
      }

      const [inProgress, relayJobs] = await Promise.all([
        prisma.chapterUpdateJob.count({
          where: { repositoryId: doc.repositoryId, kind: 'RELAY', status: { in: ['CLAIMED', 'TRIAL'] } },
        }),
        prisma.chapterUpdateJob.findMany({
          where: { repositoryId: doc.repositoryId, status: { in: ['CLAIMED', 'TRIAL', 'SWAPPED'] } },
          select: { status: true, claimedBy: true },
        }),
      ]);
      const participantIds = [...new Set(relayJobs.map((j) => j.claimedBy).filter((v): v is string => !!v))];
      const participantUsers = participantIds.length
        ? await prisma.user
            .findMany({ where: { id: { in: participantIds } }, select: { id: true, name: true, image: true } })
            .catch(() => [])
        : [];
      const activeIds = new Set(
        relayJobs.filter((j) => j.status !== 'SWAPPED').map((j) => j.claimedBy).filter((v): v is string => !!v)
      );
      const participants = participantUsers
        .map((u) => ({ userId: u.id, name: u.name, image: u.image, active: activeIds.has(u.id) }))
        .sort((a, b) => Number(b.active) - Number(a.active));
      const { RelayWaitingChapter } = await import('@/components/update/RelayWaitingChapter');
      const claimableJobId =
        activeUpdateJob && activeUpdateJob.status === 'PENDING' && activeUpdateJob.kind === 'RELAY'
          ? activeUpdateJob.id
          : null;
      return (
        <DocsPage toc={[]} full={false}>
          <DocsBody>
            <RelayWaitingChapter
              documentId={doc.id}
              docTitle={doc.title || null}
              docPath={doc.path}
              claimableJobId={claimableJobId}
              estimatedCredits={0}
              progress={{ done: bakedCount, total: chapterTotal, inProgress }}
              participants={participants}
            />
          </DocsBody>
        </DocsPage>
      );
    }

    const activeJob = await prisma.transcriptionJob.findFirst({
      where: { documentId: doc.id, status: { in: ['RUNNING', 'QUEUED'] } },
      select: {
        id: true,
        status: true,
        claimedAt: true,
        createdAt: true,
        options: true,
      },
    });

    const progressInfo = (activeJob?.options as any)?.progressInfo;
    const initialStartedAt = activeJob?.claimedAt
      ? activeJob.claimedAt.getTime()
      : activeJob?.createdAt
        ? activeJob.createdAt.getTime()
        : null;
    const initialProgress = typeof progressInfo?.progress === 'number' ? progressInfo.progress : null;
    const initialStep = typeof progressInfo?.step === 'string' ? progressInfo.step : null;

    const UninitializedChapter = (await import('@/components/ingest/UninitializedChapter')).default;
    return (
      <DocsPage>
        <DocsBody>
          <UninitializedChapter
            docId={doc.id}
            docPath={doc.path}
            docTitle={doc.title || null}
            edition={edition}
            initialStartedAt={initialStartedAt}
            initialProgress={initialProgress}
            initialStep={initialStep}
          />
        </DocsBody>
      </DocsPage>
    );
  }

  const rawMdx = doc.content || '';
  const { MdxContent, safeToc, frontmatter, compileFailed } = await compileDocMdx(rawMdx, relativePath, doc.title);

  // 教学顺序的上一章/下一章与站内超链接重映射上下文（激活大纲存在时；失败静默——导航是增强能力）
  let prevNext: { prev: { title: string; url: string } | null; next: { title: string, url: string } | null } = { prev: null, next: null };
  let activeOutline: OutlineView | null = null;
  try {
    const { getActiveOutline } = await import('@/lib/outline-reader');
    const outline = await getActiveOutline(doc.repositoryId);
    if (outline) {
      activeOutline = outline;
      const { prev, next } = adjacentNavigableNodes(outline, doc.path);
      const toLink = (n: { title: string; docPath: string | null }) => {
        const url = outlineNodeUrl(owner, repo, n.docPath);
        return url ? { title: n.title, url } : null;
      };
      prevNext = { prev: prev && prev.docPath ? toLink(prev) : null, next: next && next.docPath ? toLink(next) : null };
    }
  } catch (e) {
    console.warn('[DocsPage] prev/next resolution skipped:', e);
  }

  const isWebDoc = isWebDocRepository({
    owner,
    repo,
    repoProfile,
  });

  const webDocLinkContext = isWebDoc
    ? buildWebDocLinkContext({
        owner,
        repo,
        outline: activeOutline,
        navTree: ((repository?.navTree ?? doc.repository?.navTree) as any) ?? null,
        repoProfile: profile,
        currentDocPath: doc.path,
        edition: edition ?? null,
      })
    : null;

  const customComponents = buildDocCustomComponents({
    owner,
    repo,
    gitSha: doc.repository?.gitSha,
    branch: doc.repository?.branch,
    webDocLinkContext,
  });

  return (
    <DocumentProvider documentId={doc.id} repositoryId={doc.repositoryId}>
      <CodeDrawer owner={owner} repo={repo} gitSha={doc.repository?.gitSha} />
      <ScrollRestorer docPath={doc.path} owner={owner} repo={repo} />
      <UpstreamUpdateToast
        owner={owner}
        repo={repo}
        hasUpstreamUpdate={Boolean(doc.repository?.hasUpstreamUpdate)}
      />
      <DocsPage toc={isApiDoc ? [] : safeToc} full={isApiDoc ? true : frontmatter?.full} footer={{ enabled: false }}>
        {editionFallback && (
          <p className="mb-4 text-xs text-theme-muted font-sans">
            {m.edition_fallback_notice()}
          </p>
        )}

        {hasOpenApi && !isApiDoc && (
          <div className="mb-4">
            <Link
              href={`/docs/${owner}/${repo}/api-reference`}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20 hover:bg-theme-primary/20 transition-colors"
            >
              <span>⚡ 1:1 API Reference 与 MCP 交互视窗</span>
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        )}

        {(frontmatter?.title || doc.title) && (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-0">
              <DocsTitle className="docs-page-title no-underline text-theme-foreground mb-0">
                {frontmatter?.title || doc.title}
              </DocsTitle>
              <GenerationLevelBadge level={doc.generationLevel} />
            </div>
            <div className="shrink-0">
              <ChapterShareButton
                title={frontmatter?.title || doc.title}
                isPublic={Boolean(doc.repository?.isPublic)}
              />
            </div>
          </div>
        )}

        {!isApiDoc && (
          <ChapterDegradedNotice
            documentId={doc.id}
            generationLevel={doc.generationLevel}
            targetLanguage={((repoProfile as any)?.targetLanguage as string) || null}
          />
        )}

        {activeUpdateJob && (
          <ComponentErrorBoundary>
            <ChapterUpdateCapsule
              owner={owner}
              repo={repo}
              job={activeUpdateJob as ActiveUpdateJob}
              isLoggedIn={!!userId}
            />
          </ComponentErrorBoundary>
        )}

        {chapterVersions.length > 0 && (
          <ComponentErrorBoundary>
            <ChapterVersionSwitcher
              documentId={doc.id}
              versions={chapterVersions.map((cv: any) => ({
                id: cv.id,
                authorId: cv.authorId,
                authorName: cv.author?.name ?? null,
                authorImage: cv.author?.image ?? null,
                voteCount: cv.voteCount,
                isCanonical: cv.isCanonical,
                visibility: cv.visibility,
                source: cv.source,
                createdAt: cv.createdAt.toISOString(),
                viewerVoted: viewerVersionVotes.has(cv.id),
              }))}
              activeVersionId={activeVersion?.id ?? null}
              viewerId={userId ?? null}
              isMaintainer={showAutoSyncSwitch}
            />
          </ComponentErrorBoundary>
        )}

        <DocsBody className="mdx-content-container">
          <div id="doc-content-area">
            {isApiDoc ? (
              <ComponentErrorBoundary>
                <ScalarApiViewer
                  specUrl={openApiProxyUrl}
                />
              </ComponentErrorBoundary>
            ) : compileFailed ? (
              <GfmFallbackRenderer 
                content={rawMdx} 
                owner={owner}
                repo={repo}
                webDocLinkContext={webDocLinkContext}
              />
            ) : (
              <ComponentErrorBoundary
                fallback={
                  <GfmFallbackRenderer 
                    content={rawMdx} 
                    owner={owner}
                    repo={repo}
                    webDocLinkContext={webDocLinkContext}
                  />
                }
              >
                <MdxContent components={customComponents} />
              </ComponentErrorBoundary>
            )}

            {!isApiDoc && (
              <>
                {/* Auto-injected Micro-Quiz at the end of the page (代码教程及 AI 教学衍生讲法显示；1:1 原生 WebDoc 镜像保持极简) */}
                {!isNativeWebMirror && (
                  <div className="mt-8 pt-8 border-t border-theme-border">
                    <ComponentErrorBoundary fallbackTitle={m.quiz_fallback_error_title()}>
                      {/* 内容寻址快照（性能修复 2026-10-13）：不再把整章 MDX 原文二次
                          序列化进 RSC payload——传 documentId + 读者正在读的版本 contentId */}
                      <MicroQuiz
                        documentId={doc.id}
                        contentId={activeVersion?.contentId ?? doc.contentId ?? null}
                      />
                    </ComponentErrorBoundary>
                  </div>
                )}

                {/* Inject ChapterFoldout if chapterAssets exist for this doc */}
                {chapterAssets && chapterAssets.length > 0 && (
                  <ComponentErrorBoundary>
                    <ChapterFoldout assets={chapterAssets} />
                  </ComponentErrorBoundary>
                )}

                {/* 译文反馈与社区共建卡片（仅非 1:1 原生镜像展示） */}
                {!isNativeWebMirror && (
                  <ComponentErrorBoundary>
                    <ChapterFeedbackCard
                      documentId={doc.id}
                      viewerId={userId ?? null}
                      isPublic={Boolean(doc.repository?.isPublic)}
                    />
                  </ComponentErrorBoundary>
                )}
              </>
            )}
          </div>
        </DocsBody>

        {/* 同步历史（同步即贡献显性化） */}
        {syncHistory.length > 0 && (
          <ComponentErrorBoundary>
            <SyncHistoryList runs={syncHistory as Parameters<typeof SyncHistoryList>['0']['runs']} />
          </ComponentErrorBoundary>
        )}

        {/* 外部访客入架转化与二次分享闭环 */}
        {!userId && doc.repository?.isPublic && (
          <ComponentErrorBoundary>
            <GuestShelfJoinCallout
              title={frontmatter?.title || doc.title}
              owner={owner}
              repo={repo}
              isPublic={Boolean(doc.repository?.isPublic)}
            />
          </ComponentErrorBoundary>
        )}

        {/* 上一章/下一章（教学顺序） */}
        <ComponentErrorBoundary>
          <ChapterPrevNextNav prev={prevNext.prev} next={prevNext.next} />
        </ComponentErrorBoundary>

        {/* 增长钩子 */}
        {doc.repository?.isPublic && doc.repository?.publishedAt && (
          <p className="mt-10 pt-6 border-t border-theme-border/60 text-center text-xs text-theme-muted">
            {m.common_powered_by()}{' '}
            <a
              href={CLOUD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-serif italic text-theme-foreground/70 hover:text-theme-primary transition-colors"
            >
              OpenGits
            </a>
          </p>
        )}
      </DocsPage>
    </DocumentProvider>
  );
}
