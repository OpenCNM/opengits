import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import * as m from '@/paraglide/messages';
import { ChevronLeft } from 'lucide-react';

import SyncPrompt from '@/components/SyncPrompt';
import { AITelemetryProvider } from '@/components/telemetry/AITelemetryProvider';
import { RepoViewBeacon } from '@/components/docs/RepoViewBeacon';
import { resolveRepositoryAnyEdition, isRepositoryGroupPublic } from '@/lib/repository-resolver';
import { EditionAwareDocsLayout, DocsEditionSwitcher, DocsEditionModelBadge } from '@/components/docs/DocsEdition';
import { DocsModuleTabs } from '@/components/docs/DocsModuleTabs';
import { AskAiNavButton } from '@/components/docs/AskAiNavButton';
import { DocsSplitShell } from '@/components/docs/DocsSplitShell';
import {
  collectImportedDocPaths,
  detectHasChangelogDoc,
  resolveModuleTabEntries,
} from '@/lib/docs/webdoc-module-tabs';
import type { ModuleTab } from '@/lib/schemas/webdoc-topology';
import { SidebarAgentCard, ReportNavButton, HelpfulNavButton } from '@/components/mdx/DocNavActions';

import { ReadingProgressProvider } from '@/components/telemetry/ReadingProgressContext';
import { IngestQueueProvider } from '@/components/ingest/IngestQueueContext';
import { AssistantContainer } from '@/components/chat/AssistantContainer';
import { DocsLoginGate } from '@/components/docs/DocsLoginGate';
import { getSessionHelper } from '@/lib/auth-helper';
import { loadDocsLayoutData } from '@/lib/docs/docs-layout-loader';
import { buildFumadocsPageTree } from '@/lib/docs/docs-nav-tree';
import { ComponentErrorBoundary } from '@/components/ui/ComponentErrorBoundary';

// 公开仓匿名可读 + 可索引（SEO 获客面）；私有仓一律 noindex。
// 组级判定：基础行被他人私有导入时，同组存在公开讲法行仍可索引（与裸 URL 可见性回退同口径）。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  const resolved = await resolveRepositoryAnyEdition(owner, repo).catch(() => null);
  const isPublic = resolved?.repository
    ? (resolved.repository.isPublic || (await isRepositoryGroupPublic(owner, repo).catch(() => false)))
    : false;
  return { robots: isPublic ? { index: true, follow: true } : { index: false, follow: false } };
}

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;

  const session = await getSessionHelper();
  const userId = session?.user?.id;

  const result = await loadDocsLayoutData(owner, repo, userId);

  if (result.status === 'login-gate') {
    const { loginGateData } = result;
    return (
      <DocsLoginGate
        owner={owner}
        repo={repo}
        title={loginGateData.title}
        chapterCount={loginGateData.chapterCount}
        bakedCount={loginGateData.bakedCount}
        relayInProgress={loginGateData.relayInProgress}
        relayParticipants={loginGateData.relayParticipants}
      />
    );
  }

  if (result.status === 'not-found') {
    notFound();
  }

  if (result.status === 'forbidden') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-theme-foreground bg-theme-bg p-4 text-center">
        <h1 className="text-2xl font-bold text-theme-accent">{m.error_forbidden_title()}</h1>
        <p className="mt-2 text-theme-muted">{m.error_forbidden_desc()}</p>
        <Link href="/" className="mt-4 px-4 py-2 bg-theme-foreground hover:bg-theme-foreground text-theme-bg rounded transition shadow">
          {m.account_back_to_bookshelf()}
        </Link>
      </div>
    );
  }

  if (result.status === 'sync-prompt') {
    return (
      <div className="relative flex flex-col min-h-screen bg-theme-bg text-theme-foreground font-sans w-full overflow-hidden">
        <div className="absolute inset-0 bg-[url('/noise.svg')] opacity-[0.035] pointer-events-none mix-blend-multiply"></div>
        <div className="absolute inset-0 bg-gradient-to-b from-stone-50/50 via-stone-50/80 to-theme-bg pointer-events-none"></div>
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center">
          <SyncPrompt owner={owner} repo={repo} canSync={result.canSync} />
        </div>
      </div>
    );
  }

  if (result.status !== 'ready') {
    notFound();
  }

  const {
    repository,
    repositoryId,
    repoProfile,
    repoIsPublic,
    relayEnabled,
    isMaintainer,
    helpfulInfo,
    transcriptionModels,
    editionOptions,
    resolvedBranch,
    outline,
    navTree,
    chapterScores,
    hotPaths,
    editionProjections,
  } = result;

  // 仅在「个人私有仓库且由维护者本人访问」或当前用户拥有私有衍生讲法时，启用全量批量转录管理与悬浮胶囊；
  // 公共教程与社区接力教程属于公共资产，章节按需接力认领转录，绝不展示全量入库管理胶囊与自动抢跑插队。
  const hasPersonalEditions = Boolean(userId && editionOptions?.some((e) => !e.isDefault && e.edition));
  const isPersonalBatchMode = (!repoIsPublic && !relayEnabled && isMaintainer) || hasPersonalEditions;

  const repoProfileObj = (repoProfile as Record<string, unknown> | null) ?? {};
  const moduleTabs = Array.isArray(repoProfileObj.moduleTabs)
    ? (repoProfileObj.moduleTabs as ModuleTab[])
    : [];
  const allowedPrefixes = Array.isArray(repoProfileObj.allowedPrefixes)
    ? repoProfileObj.allowedPrefixes.filter((p): p is string => typeof p === 'string')
    : [];
  const primaryDocPrefix =
    typeof repoProfileObj.primaryDocPrefix === 'string'
      ? repoProfileObj.primaryDocPrefix
      : undefined;
  const hasOpenApi = Boolean(
    repoProfileObj.hasOpenApi || repoProfileObj.openApiUrl,
  );
  const importedDocPaths = collectImportedDocPaths(outline, navTree);
  const hasChangelogDoc = detectHasChangelogDoc(outline, navTree);
  const resolvedModuleTabs = resolveModuleTabEntries({
    owner,
    repo,
    moduleTabs,
    allowedPrefixes,
    importedDocPaths,
    hasOpenApi,
    hasChangelogDoc,
  });

  const pageTree = buildFumadocsPageTree({
    outline,
    navTree,
    owner,
    repo,
    hotPaths,
    repoProfile,
    resolvedBranch,
  });

  const editionTrees: Record<string, any> = {};
  if (editionProjections) {
    for (const [edKey, proj] of Object.entries(editionProjections)) {
      editionTrees[edKey] = buildFumadocsPageTree({
        outline: proj.outline,
        navTree: proj.navTree,
        owner,
        repo,
        hotPaths,
        repoProfile: proj.repoProfile,
        resolvedBranch: proj.branch,
      });
    }
  }

  return (
    <AITelemetryProvider>
      <IngestQueueProvider
        owner={owner}
        repo={repo}
        initialEditions={editionOptions}
        liveUpdates={isPersonalBatchMode || isMaintainer}
      >
        <ReadingProgressProvider owner={owner} repo={repo} initialChapterScores={chapterScores}>
          <DocsSplitShell
            aside={
              <ComponentErrorBoundary>
                <AssistantContainer owner={owner} repo={repo} repositoryId={repositoryId} />
              </ComponentErrorBoundary>
            }
            navButton={
              <ComponentErrorBoundary key="docs-top-right-ask-ai">
                <AskAiNavButton />
              </ComponentErrorBoundary>
            }
          >
            <EditionAwareDocsLayout
              tree={pageTree}
              editionTrees={editionTrees}
              themeSwitch={{ enabled: false }}
              nav={{
                url: '/',
                title: (
                  <div
                    className="flex items-center gap-2 text-left group/title select-none cursor-pointer flex-1 min-w-0 w-full p-1.5 -ml-1.5 rounded-lg hover:bg-theme-surface/70 transition-colors"
                    title={m.account_back_to_bookshelf()}
                  >
                    <ChevronLeft
                      size={16}
                      className="text-theme-muted group-hover/title:text-theme-primary transition-transform group-hover/title:-translate-x-0.5 shrink-0"
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-compact font-semibold text-theme-muted uppercase tracking-wider leading-none truncate">
                        {owner}
                      </span>
                      <span className="text-xs font-bold text-theme-foreground capitalize mt-0.5 leading-tight truncate group-hover/title:text-theme-primary transition-colors">
                        {repo.replace(/-/g, ' ')}
                      </span>
                    </div>
                  </div>
                ),
                children: (
                  <div className="flex items-center gap-2">
                    {resolvedModuleTabs.length > 1 && (
                      <ComponentErrorBoundary key="docs-module-tabs">
                        <DocsModuleTabs
                          owner={owner}
                          repo={repo}
                          resolvedTabs={resolvedModuleTabs}
                          primaryDocPrefix={primaryDocPrefix}
                        />
                      </ComponentErrorBoundary>
                    )}
                    <ComponentErrorBoundary key="docs-edition-switcher">
                      <DocsEditionSwitcher
                        editions={editionOptions}
                        owner={owner}
                        repo={repo}
                        editionTrees={editionTrees}
                      />
                    </ComponentErrorBoundary>
                  </div>
                ),
              }}
              sidebar={{
                footer: (
                  <div key="sidebar-footer-container" className="space-y-3">
                    <ComponentErrorBoundary key="sidebar-agent-card">
                      <SidebarAgentCard owner={owner} repo={repo} repositoryId={repositoryId} />
                    </ComponentErrorBoundary>
                    {(helpfulInfo || (repoIsPublic && userId)) && (
                      <ComponentErrorBoundary key="sidebar-helpful-report">
                        <div className="flex items-center justify-between">
                          {helpfulInfo ? (
                            <HelpfulNavButton
                              owner={owner}
                              repo={repo}
                              initialCount={helpfulInfo.count}
                              initialVoted={helpfulInfo.voted}
                            />
                          ) : <div />}
                          {repoIsPublic && userId && (
                            <ReportNavButton owner={owner} repo={repo} repoId={repositoryId} />
                          )}
                        </div>
                      </ComponentErrorBoundary>
                    )}
                    <ComponentErrorBoundary key="sidebar-model-badge">
                      <DocsEditionModelBadge
                        editions={editionOptions}
                        fallbackModels={transcriptionModels}
                      />
                    </ComponentErrorBoundary>
                  </div>
                ),
              }}
            >
              {children}
            </EditionAwareDocsLayout>
          </DocsSplitShell>
          <ComponentErrorBoundary>
            <RepoViewBeacon repositoryId={repositoryId} />
          </ComponentErrorBoundary>
        </ReadingProgressProvider>
      </IngestQueueProvider>
    </AITelemetryProvider>
  );
}
