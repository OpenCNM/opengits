'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, Search } from 'lucide-react';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { UpdatePlanDialog } from '@/components/update/UpdatePlanDialog';
import { UpdateWorkbenchModal } from '@/components/update/UpdateWorkbenchModal';
import { EditionDrawer } from '@/components/repo/EditionChips';
import { McpConnectWizardDialog } from '@/components/mcp-connect/McpConnectWizardDialog';
import { useImportWizard } from '@/components/ImportWizard/ImportWizardContext';
import { requireApiKey } from '@/lib/api-key-guard';
import { WEB_DOC_OWNER } from '@/lib/constants';
import { DashboardResumeCard } from './dashboard/DashboardResumeCard';
import { DashboardSidebarRepoList } from './dashboard/DashboardSidebarRepoList';
import { DashboardMcpClientsPanel } from './dashboard/DashboardMcpClientsPanel';
import { DashboardFeedSection } from './dashboard/DashboardFeedSection';
import { TutorialDetailDialog } from './dashboard/TutorialDetailDialog';
import { ManageProjectsDialog } from './dashboard/ManageProjectsDialog';
import { StarterPackOnboardingDialog } from './dashboard/StarterPackOnboardingDialog';
import { DashboardSearchHub } from './dashboard/DashboardSearchHub';
import { api } from '@/lib/api/client';
import type { StarterPackItem } from '@/lib/starter-packs/starter-packs';
import { DashboardSourceFilterPills } from './dashboard/DashboardSourceFilterPills';
import { calculateSourceTypeCounts, type DashboardSourceType } from '@/lib/search/smart-repo-search';
import { HomeFooter } from './HomeFooter';
import * as m from '@/paraglide/messages';

import { useDashboardQueryParams, type DashboardFeedTab } from '../hooks/useDashboardQueryParams';
import { useDashboardMcpClients } from '../hooks/useDashboardMcpClients';
import { useDashboardRepoActions } from '../hooks/useDashboardRepoActions';
import { useDashboardFeed } from '../hooks/useDashboardFeed';
import {
  dashboardKeepAliveStore,
  getDashboardSnapshot,
  saveDashboardSnapshot,
} from '@/lib/stores/dashboard-keepalive-store';

export type { DashboardFeedTab };

interface UserDashboardViewProps {
  repos: DisplayRepo[];
  myRepos?: DisplayRepo[];
  filteredRepos: DisplayRepo[];
  categories: string[];
  selectedCategory: string;
  setSelectedCategory: (cat: string) => void;
  inputUrl: string;
  setInputUrl: (url: string) => void;
  handleImportSubmit: (e?: React.FormEvent, customUrl?: string) => void;
  handleToggleSave: (repo: DisplayRepo, autoFollow?: boolean) => Promise<void> | void;
  handleToggleFavorite?: (repo: DisplayRepo) => Promise<void> | void;
  handleRemoveRepo?: (repo: DisplayRepo) => Promise<void> | void;
  setMcpDialogRepo: (repo: { owner: string; repo: string; title?: string } | null) => void;
  isLoggedIn?: boolean;
  isAuthenticated?: boolean;
  hasPreferencesSet?: boolean;
  initialActiveTab?: string;
  initialSort?: string;
  searchQuery?: string;
  setSearchQuery?: (q: string) => void;
  sourceType?: DashboardSourceType;
  setSourceType?: (s: DashboardSourceType) => void;
  highlightRepo?: string | null;
  onEditionDeleted?: (editionId: string) => void;
}

export function UserDashboardView({
  repos,
  myRepos = [],
  filteredRepos,
  categories,
  selectedCategory,
  setSelectedCategory,
  inputUrl,
  setInputUrl,
  handleImportSubmit,
  handleToggleSave,
  handleToggleFavorite,
  handleRemoveRepo,
  setMcpDialogRepo,
  isLoggedIn = false,
  isAuthenticated = false,
  hasPreferencesSet = true,
  initialActiveTab,
  initialSort,
  searchQuery = '',
  setSearchQuery,
  sourceType: propSourceType = 'all',
  setSourceType: propSetSourceType,
  highlightRepo = null,
  onEditionDeleted,
}: UserDashboardViewProps) {
  const router = useRouter();

  const {
    activeTab,
    setActiveTab,
    currentSort,
    handleSortChange,
    sourceType: querySourceType,
    setSourceType: querySetSourceType,
    currentPage,
    setCurrentPage,
  } = useDashboardQueryParams({
    initialActiveTab,
    initialSort,
    selectedCategory,
    initialSourceType: propSourceType,
  });

  const effectiveSourceType = propSourceType ?? querySourceType;
  const handleSelectSourceType = (type: DashboardSourceType) => {
    querySetSourceType(type);
    propSetSourceType?.(type);
  };
  const sourceCounts = React.useMemo(() => calculateSourceTypeCounts(repos), [repos]);
  const favoritesCount = React.useMemo(
    () => repos.filter((r) => Boolean(r.isFavorited)).length,
    [repos]
  );
  const matchedFirstRepo = filteredRepos.length > 0 ? filteredRepos[0] : null;

  const { activeClients } = useDashboardMcpClients();

  const {
    updateTarget,
    setUpdateTarget,
    checkingRepoId,
    editionSavedOverrides,
    followOverrides,
    pinnedOverrides,
    updateStatusOverrides,
    handleEditionSavedChange,
    handleTogglePin,
    handleToggleFollow,
    handleCheckAndUpdate,
  } = useDashboardRepoActions();

  const [isManageDialogOpen, setIsManageDialogOpen] = useState(false);
  const [personalSearch, setPersonalSearch] = useState('');
  const [detailRepo, setDetailRepo] = useState<DisplayRepo | null>(null);
  const activeDetailRepo = React.useMemo(() => {
    if (!detailRepo) return null;
    const matched =
      repos.find((r) => r.id === detailRepo.id) ||
      myRepos.find((r) => r.id === detailRepo.id);
    return matched ? { ...detailRepo, ...matched } : detailRepo;
  }, [detailRepo, repos, myRepos]);
  const [relayTarget, setRelayTarget] = useState<DisplayRepo | null>(null);
  const [editionDrawer, setEditionDrawer] = useState<{
    editions: EditionChip[];
    owner: string;
    repo: string;
  } | null>(null);
  const [isMcpWizardOpen, setIsMcpWizardOpen] = useState(false);
  const [starterPacks, setStarterPacks] = useState<StarterPackItem[]>([]);
  const [isStarterPackDialogOpen, setIsStarterPackDialogOpen] = useState(false);
  const [isFirstTimeOnboarding, setIsFirstTimeOnboarding] = useState(false);
  const hasAutoPromptedStarterRef = React.useRef(false);

  useEffect(() => {
    if (!isAuthenticated || hasPreferencesSet || myRepos.length > 0 || hasAutoPromptedStarterRef.current) {
      return;
    }
    hasAutoPromptedStarterRef.current = true;
    let cancelled = false;
    api
      .get<{ packs?: StarterPackItem[]; hasPreferencesSet?: boolean }>('/api/starter-packs', {
        onUnauthorized: 'throw',
      })
      .then((res) => {
        if (cancelled) return;
        const packs = res?.packs || [];
        if (packs.length > 0 && !res?.hasPreferencesSet) {
          setStarterPacks(packs);
          setIsFirstTimeOnboarding(true);
          setIsStarterPackDialogOpen(true);
        }
      })
      .catch((err) => {
        console.warn('[UserDashboardView] fetch starter packs failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, hasPreferencesSet, myRepos.length]);

  const openStarterPacksDialog = React.useCallback(async () => {
    try {
      const res = await api.get<{ packs?: StarterPackItem[] }>('/api/starter-packs');
      const packs = res?.packs || [];
      if (packs.length === 0) return;
      setStarterPacks(packs);
      setIsFirstTimeOnboarding(false);
      setIsStarterPackDialogOpen(true);
    } catch (err) {
      console.warn('[UserDashboardView] openStarterPacksDialog failed:', err);
    }
  }, []);
  const { openWizardForEdition, openWizard, setUrl } = useImportWizard();

  const handleSearchTag = React.useCallback(
    (tag: string) => {
      setSearchQuery?.(tag);
      const params = new URLSearchParams(window.location.search);
      params.set('q', tag);
      params.delete('highlight');
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    },
    [setSearchQuery, router]
  );

  const mainCanvasRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        const snapshot = getDashboardSnapshot();
        if (snapshot.scrollOffset > 0) {
          if (mainCanvasRef.current && mainCanvasRef.current.scrollHeight > mainCanvasRef.current.clientHeight) {
            mainCanvasRef.current.scrollTop = snapshot.scrollOffset;
          } else if (typeof window !== 'undefined') {
            window.scrollTo({ top: snapshot.scrollOffset, behavior: 'instant' as ScrollBehavior });
          }
        }
      } catch {
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const saveCurrentScroll = () => {
      try {
        const offset =
          mainCanvasRef.current && mainCanvasRef.current.scrollTop > 0
            ? mainCanvasRef.current.scrollTop
            : typeof window !== 'undefined'
            ? window.scrollY || document.documentElement.scrollTop
            : 0;
        if (offset >= 0) {
          saveDashboardSnapshot({ scrollOffset: offset });
        }
      } catch {
      }
    };

    const handleScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveCurrentScroll, 120);
    };

    const el = mainCanvasRef.current;
    if (el) {
      el.addEventListener('scroll', handleScroll, { passive: true });
    }
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      if (timer) clearTimeout(timer);
      saveCurrentScroll();
      if (el) {
        el.removeEventListener('scroll', handleScroll);
      }
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const [personalSourceType, setPersonalSourceType] = useState<DashboardSourceType>('all');

  const {
    allPersonalRepos,
    personalRepos,
    personalSourceCounts,
    displayFeedRepos,
    paginatedFeedRepos,
    recentResumeRepo,
    totalItems,
    totalPages,
    safeCurrentPage,
    pageSize,
  } = useDashboardFeed({
    repos,
    myRepos,
    filteredRepos,
    activeTab,
    currentPage,
    personalSearch,
    personalSourceType,
    pinnedOverrides,
  });

  const editionsOf = (repo: DisplayRepo): EditionChip[] | undefined => {
    let editions = repo.editionGroup?.editions;
    if (!editions || editions.length <= 1) {
      const key = `${(repo.owner || '').toLowerCase()}/${(repo.repo || '').toLowerCase()}`;
      const partner = [...myRepos, ...repos].find(
        (r) =>
          r.id !== repo.id &&
          `${(r.owner || '').toLowerCase()}/${(r.repo || '').toLowerCase()}` === key &&
          (r.editionGroup?.editions?.length ?? 0) > 1
      );
      if (partner?.editionGroup?.editions) {
        editions = partner.editionGroup.editions;
      }
    }
    if (!editions || editions.length <= 1) return undefined;
    return editions.map((e) => ({
      ...e,
      isSaved: editionSavedOverrides[e.id] ?? e.isSaved,
      hasUpdate: updateStatusOverrides[e.id] ?? e.hasUpdate,
    }));
  };

  return (
    <main className="w-full h-full flex flex-col md:flex-row items-stretch select-none md:overflow-hidden">
      <aside className="w-full md:w-80 md:min-w-[20rem] md:max-w-[20rem] lg:w-[21rem] lg:min-w-[21rem] lg:max-w-[21rem] shrink-0 bg-theme-bg py-6 px-4 sm:px-6 lg:pl-8 lg:pr-6 flex flex-col justify-between md:h-full md:min-h-0 md:overflow-hidden space-y-4">
        <div className="flex-1 min-h-0 flex flex-col space-y-3.5 overflow-hidden">
          <div className="shrink-0 flex items-center justify-between pb-1">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs uppercase tracking-wider text-theme-foreground/90 flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5 text-theme-foreground/70" />
                {m.dashboard_my_projects()}
              </span>
              <span className="text-micro font-mono text-theme-muted">({personalRepos.length})</span>
            </div>
            {allPersonalRepos.length > 0 && (
              <button
                type="button"
                onClick={() => setIsManageDialogOpen(true)}
                className="text-xs px-2 py-0.5 rounded-md font-sans transition-all cursor-pointer text-theme-muted hover:text-theme-foreground hover:bg-theme-surface"
              >
                {m.dashboard_manage_projects()}
              </button>
            )}
          </div>

          <div className="shrink-0 relative">
            <Search className="w-3.5 h-3.5 text-theme-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={personalSearch}
              onChange={(e) => setPersonalSearch(e.target.value)}
              placeholder={m.placeholder_search()}
              className="w-full h-9 pl-8 pr-2.5 bg-theme-bg border border-theme-border/80 rounded-lg text-xs font-sans text-theme-foreground outline-none focus:border-theme-primary transition-colors placeholder:text-theme-muted/50"
            />
          </div>

          {allPersonalRepos.length > 0 && (
            <DashboardSourceFilterPills
              compact
              sourceType={personalSourceType}
              onSelectSourceType={setPersonalSourceType}
              counts={personalSourceCounts}
            />
          )}

          <DashboardSidebarRepoList
            repos={personalRepos}
            editionsOf={editionsOf}
            isFiltered={personalSourceType !== 'all' || Boolean(personalSearch.trim())}
            checkingRepoId={checkingRepoId}
            onOpenEditionDrawer={setEditionDrawer}
            onOpenUpdateDialog={setUpdateTarget}
            onCheckUpdate={handleCheckAndUpdate}
            onTogglePin={handleTogglePin}
            onEditionSavedChange={handleEditionSavedChange}
            onCreateEdition={(owner, repo) => requireApiKey(() => openWizardForEdition(owner, repo))}
            onOpenDetail={setDetailRepo}
            onOpenStarterPacks={isAuthenticated ? openStarterPacksDialog : undefined}
          />
        </div>

        <div className="shrink-0 pt-2">
          <DashboardMcpClientsPanel
            clients={activeClients}
            onOpenWizard={() => setIsMcpWizardOpen(true)}
          />
        </div>
      </aside>

      <div
        ref={mainCanvasRef}
        className="flex-1 min-w-0 md:h-full md:overflow-y-auto py-6 px-5 sm:px-6 lg:px-8 flex flex-col space-y-8 bg-theme-bg"
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 xl:col-span-8">
              <DashboardSearchHub
                searchQuery={searchQuery}
                setSearchQuery={(q) => {
                  setSearchQuery?.(q);
                  setInputUrl(q);
                }}
                onClearSearch={() => {
                  setSearchQuery?.('');
                  setInputUrl('');
                  const params = new URLSearchParams(window.location.search);
                  params.delete('q');
                  params.delete('highlight');
                  const qs = params.toString();
                  router.replace(qs ? `/?${qs}` : '/', { scroll: false });
                }}
                onSearchSubmit={(e) => {
                  e?.preventDefault();
                  const feedEl = document.getElementById('feed-section');
                  if (feedEl) {
                    feedEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                onImportSubmit={(e) => {
                  e?.preventDefault();
                  const target = searchQuery.trim() || inputUrl.trim();
                  handleImportSubmit(e, target);
                }}
                sourceType={effectiveSourceType}
                onSelectSourceType={handleSelectSourceType}
                sourceCounts={sourceCounts}
                matchedCount={filteredRepos.length}
                matchedFirstRepo={matchedFirstRepo}
              />
            </div>

            <DashboardResumeCard
              recentResumeRepo={recentResumeRepo}
              onToggleSave={handleToggleSave}
            />
          </div>

          <DashboardFeedSection
            displayFeedRepos={displayFeedRepos}
            paginatedFeedRepos={paginatedFeedRepos}
            categories={categories}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            currentSort={currentSort}
            handleSortChange={handleSortChange}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            totalItems={totalItems}
            safeCurrentPage={safeCurrentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            setCurrentPage={setCurrentPage}
            editionsOf={editionsOf}
            followOverrides={followOverrides}
            handleToggleFollow={handleToggleFollow}
            handleToggleSave={handleToggleSave}
            handleToggleFavorite={handleToggleFavorite}
            favoritesCount={favoritesCount}
            setEditionDrawer={setEditionDrawer}
            setRelayTarget={setRelayTarget}
            handleEditionSavedChange={handleEditionSavedChange}
            openWizardForEdition={openWizardForEdition}
            searchQuery={searchQuery}
            onClearSearch={() => {
              setSearchQuery?.('');
              const params = new URLSearchParams(window.location.search);
              params.delete('q');
              params.delete('highlight');
              const qs = params.toString();
              router.replace(qs ? `/?${qs}` : '/', { scroll: false });
            }}
            sourceType={effectiveSourceType}
            onClearSource={() => handleSelectSourceType('all')}
            highlightRepo={highlightRepo}
            onOpenDetail={setDetailRepo}
            onSearchTag={handleSearchTag}
          />
        </div>

        <div className="shrink-0 mt-auto pt-4">
          <HomeFooter isDashboard />
        </div>
      </div>

      {updateTarget && (
        <UpdatePlanDialog
          open={!!updateTarget}
          onOpenChange={(open) => !open && setUpdateTarget(null)}
          owner={updateTarget.owner}
          repo={updateTarget.repo}
          branch={updateTarget.branch}
          edition={updateTarget.edition}
          onUpdated={() => router.refresh()}
        />
      )}

      {relayTarget && (
        <UpdateWorkbenchModal
          open={!!relayTarget}
          onOpenChange={(open) => {
            if (!open) {
              setRelayTarget(null);
              router.refresh();
            }
          }}
          owner={relayTarget.owner}
          repo={relayTarget.repo}
          edition={relayTarget.edition}
          repoInfo={relayTarget}
          isLoggedIn={isLoggedIn}
        />
      )}

      <EditionDrawer
        open={!!editionDrawer}
        onOpenChange={(open) => !open && setEditionDrawer(null)}
        editions={editionDrawer?.editions ?? []}
        owner={editionDrawer?.owner}
        repo={editionDrawer?.repo}
        onSavedChange={handleEditionSavedChange}
        onDeleted={(id) => {
          onEditionDeleted?.(id);
          setEditionDrawer((prev) =>
            prev
              ? {
                  ...prev,
                  editions: prev.editions.filter((e) => e.id !== id),
                }
              : null
          );
        }}
        onPromoted={() => {
          router.refresh();
        }}
        canManage={editionDrawer ? editionDrawer.editions.some((e) => e.canManage || e.isMaintainer) : false}
        onCreateEdition={
          editionDrawer && editionDrawer.owner.toLowerCase() !== WEB_DOC_OWNER
            ? () => requireApiKey(() => openWizardForEdition(editionDrawer.owner, editionDrawer.repo))
            : undefined
        }
      />

      <McpConnectWizardDialog
        isOpen={isMcpWizardOpen}
        onClose={() => setIsMcpWizardOpen(false)}
        owner="bookshelf"
        repo="hub"
        title={m.dashboard_personal_global_mcp()}
      />

      <TutorialDetailDialog
        repo={activeDetailRepo}
        open={Boolean(activeDetailRepo)}
        onOpenChange={(open) => !open && setDetailRepo(null)}
        editions={activeDetailRepo ? editionsOf(activeDetailRepo) : undefined}
        canManage={activeDetailRepo ? Boolean(activeDetailRepo.canManage || activeDetailRepo.isMaintainer) : false}
        onEditionSavedChange={handleEditionSavedChange}
        onCreateEdition={(owner, repo) => requireApiKey(() => openWizardForEdition(owner, repo))}
        onCheckUpdate={handleCheckAndUpdate}
        checkingRepoId={checkingRepoId}
        onOpenUpdateDialog={setUpdateTarget}
        onOpenRelayWorkbench={(targetRepo) => {
          setDetailRepo(null);
          setRelayTarget(targetRepo);
        }}
        onToggleSave={handleToggleSave}
        onToggleFavorite={handleToggleFavorite}
        onStartImport={(url) => {
          requireApiKey(() => {
            if (url) setUrl(url);
            openWizard();
          }, m.apikey_continue_parse());
        }}
        onSelectTab={(tab) => setActiveTab(tab)}
        onSearchTag={handleSearchTag}
      />

      <ManageProjectsDialog
        open={isManageDialogOpen}
        onOpenChange={setIsManageDialogOpen}
        repos={allPersonalRepos}
        onTogglePin={handleTogglePin}
        onRemoveRepo={handleRemoveRepo}
        onOpenDetail={setDetailRepo}
        onOpenStarterPacks={isAuthenticated ? openStarterPacksDialog : undefined}
      />

      <StarterPackOnboardingDialog
        open={isStarterPackDialogOpen}
        onOpenChange={setIsStarterPackDialogOpen}
        packs={starterPacks}
        isFirstTimeOnboarding={isFirstTimeOnboarding}
        onApplied={() => router.refresh()}
      />
    </main>
  );
}
