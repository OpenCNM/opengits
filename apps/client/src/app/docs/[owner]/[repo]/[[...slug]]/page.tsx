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
import { DeepDiveToggle } from '@/components/mdx/DocNavActions';
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
    activeOutline: resolvedOutline,
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

  if (!doc.content || hasCorruptionMarker(doc.content)) {
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
  const { MdxContent, safeToc, frontmatter, compileFailed, deepDiveCount } = await compileDocMdx(rawMdx, relativePath, doc.title);

  let prevNext: { prev: { title: string; url: string } | null; next: { title: string, url: string } | null } = { prev: null, next: null };
  let activeOutline: OutlineView | null = null;
  try {
    let outline: OutlineView | null = resolvedOutline !== undefined ? resolvedOutline : null;
    if (resolvedOutline === undefined) {
      const { getActiveOutline } = await import('@/lib/outline-reader');
      outline = await getActiveOutline(doc.repositoryId);
    }
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
            {(deepDiveCount > 0 || Boolean(doc.repository?.isPublic)) && (
              <div className="shrink-0 flex items-center gap-2">
                {deepDiveCount > 0 && (
                  <DeepDiveToggle
                    key={doc.id}
                    count={deepDiveCount}
                    docKey={`${doc.id}:${activeVersion?.id ?? ''}`}
                  />
                )}
                {Boolean(doc.repository?.isPublic) && (
                  <ChapterShareButton
                    title={frontmatter?.title || doc.title}
                    isPublic={true}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {!isApiDoc && (
          <ChapterDegradedNotice
            documentId={doc.id}
            generationLevel={doc.generationLevel}
            targetLanguage={((repoProfile as any)?.targetLanguage as string) || null}
            docPath={doc.path}
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
                {!isNativeWebMirror && (
                  <div className="mt-8 pt-8 border-t border-theme-border">
                    <ComponentErrorBoundary fallbackTitle={m.quiz_fallback_error_title()}>
                      <MicroQuiz
                        documentId={doc.id}
                        contentId={activeVersion?.contentId ?? doc.contentId ?? null}
                      />
                    </ComponentErrorBoundary>
                  </div>
                )}

                {chapterAssets && chapterAssets.length > 0 && (
                  <ComponentErrorBoundary>
                    <ChapterFoldout assets={chapterAssets} />
                  </ComponentErrorBoundary>
                )}

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

        {syncHistory.length > 0 && (
          <ComponentErrorBoundary>
            <SyncHistoryList runs={syncHistory as Parameters<typeof SyncHistoryList>['0']['runs']} />
          </ComponentErrorBoundary>
        )}

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

        <ComponentErrorBoundary>
          <ChapterPrevNextNav prev={prevNext.prev} next={prevNext.next} />
        </ComponentErrorBoundary>

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
