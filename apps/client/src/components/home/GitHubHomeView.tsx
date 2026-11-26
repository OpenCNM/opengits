'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DisplayRepo } from '@/lib/home-data';
import { useImportWizard } from '@/components/ImportWizard/ImportWizardContext';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { requireApiKey } from '@/lib/api-key-guard';
import { requireAuth } from '@/lib/permissions/permission-gateway';
import { McpConnectWizardDialog as McpConnectDialog } from '@/components/mcp-connect/McpConnectWizardDialog';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';
import { GitHubHomeViewProps } from './types';
import { HomeHeader } from './components/HomeHeader';
import { HomeHeroSection } from './components/HomeHeroSection';
import { AgentDemoShowcase } from './components/AgentDemoShowcase';
import { BentoFeaturesSection } from './components/BentoFeaturesSection';
import { FaqAccordionSection } from './components/FaqAccordionSection';
import { CtaBannerSection } from './components/CtaBannerSection';
import { HomeFooter } from './components/HomeFooter';
import { UserDashboardView } from './components/UserDashboardView';
import { AnnouncementBanner } from '@/components/announcement/AnnouncementBanner';
import { getDashboardSnapshot, saveDashboardSnapshot } from '@/lib/stores/dashboard-keepalive-store';
import { normalizeCategory } from '@/lib/constants';
import { matchRepoWithSmartQuery, type DashboardSourceType } from '@/lib/search/smart-repo-search';
import { useUserCreditsStore } from '@/lib/stores/user-credits-store';
import { useGuestStore } from '@/lib/stores/guest-store';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { useModalStore } from '@/lib/stores/modal-store';

export function GitHubHomeView({
  initialRepos,
  initialMyRepos = [],
  userId: initialUserId,
  hasPreferencesSet = false,
  activeTab,
  sort,
  announcements,
}: GitHubHomeViewProps) {
  useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openWizardForEdition } = useImportWizard();
  const { openWizard, setUrl } = useImportWizard();

  const urlQuery = searchParams.get('q');
  const urlHighlight = searchParams.get('highlight');
  const urlSource = searchParams.get('source') as DashboardSourceType;

  const [isLoggedInMode, setIsLoggedInMode] = useState<boolean>(Boolean(initialUserId));
  const isGuest = useGuestStore((s) => s.isGuest);
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isGuest) {
      setIsLoggedInMode(true);
    } else if (!initialUserId) {
      setIsLoggedInMode(false);
    }
  }, [isGuest, initialUserId]);

  const effectiveLoggedInMode = mounted ? (isLoggedInMode || isGuest) : isLoggedInMode;
  const [inputUrl, setInputUrl] = useState('');

  const [searchQuery, setSearchQueryState] = useState<string>(urlQuery || '');
  const [selectedCategory, setSelectedCategoryState] = useState<string>('all');
  const [sourceType, setSourceTypeState] = useState<DashboardSourceType>(
    urlSource === 'github' || urlSource === 'webdoc' ? urlSource : 'all'
  );

  const setSelectedCategory = React.useCallback((cat: string) => {
    setSelectedCategoryState(cat);
    saveDashboardSnapshot({ selectedCategory: cat });
  }, []);

  const setSearchQuery = React.useCallback((q: string) => {
    setSearchQueryState(q);
    saveDashboardSnapshot({ searchQuery: q });
  }, []);

  const setSourceType = React.useCallback((s: DashboardSourceType) => {
    setSourceTypeState(s);
    saveDashboardSnapshot({ sourceType: s });
  }, []);

  const initialReposRef = React.useRef(initialRepos);
  initialReposRef.current = initialRepos;

  useEffect(() => {
    const snapshot = getDashboardSnapshot();
    if (snapshot.savedAt > 0) {
      if (!urlQuery && snapshot.searchQuery) {
        setSearchQueryState(snapshot.searchQuery);
      }
      if (snapshot.selectedCategory && snapshot.selectedCategory !== 'all') {
        const normSnap = normalizeCategory(snapshot.selectedCategory);
        const availableNorms = new Set(initialReposRef.current.map(r => normalizeCategory(r.category)));
        if (availableNorms.has(normSnap) && normSnap !== 'Others') {
          setSelectedCategoryState(snapshot.selectedCategory);
        } else {
          setSelectedCategoryState('all');
          saveDashboardSnapshot({ selectedCategory: 'all' });
        }
      }
      if (!urlSource && snapshot.sourceType && snapshot.sourceType !== 'all') {
        setSourceTypeState(snapshot.sourceType);
      }
    }
  }, [urlQuery, urlSource]);

  const [mcpDialogRepo, setMcpDialogRepo] = useState<{ owner: string; repo: string; title?: string } | null>(null);

  const handleOpenMcpDialog = React.useCallback(
    (target: { owner: string; repo: string; title?: string } | null) => {
      if (!target) {
        setMcpDialogRepo(null);
        return;
      }
      requireAuth(() => {
        setMcpDialogRepo(target);
      }, m.gate_reason_save_shelf());
    },
    []
  );
  const [repos, setRepos] = useState<DisplayRepo[]>(initialRepos);
  const [myRepos, setMyRepos] = useState<DisplayRepo[]>(initialMyRepos);
  const [customRepo, setCustomRepo] = useState<string>('');
  const savingRepoIdsRef = React.useRef<Set<string>>(new Set());
  const favoritingRepoIdsRef = React.useRef<Set<string>>(new Set());
  const lastSaveTriggerAtRef = React.useRef<Record<string, number>>({});

  useEffect(() => {
    setRepos(initialRepos);
  }, [initialRepos]);

  useEffect(() => {
    setMyRepos(initialMyRepos);
  }, [initialMyRepos]);

  useEffect(() => {
    let lastRefreshedAt = Date.now();
    let blurredAt: number | null = null;

    const markInactive = () => {
      if (blurredAt === null) {
        blurredAt = Date.now();
      }
    };

    const handleFocusOrVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      const now = Date.now();
      const awayMs = blurredAt !== null ? now - blurredAt : 0;
      blurredAt = null;
      if (awayMs < 5_000 || now - lastRefreshedAt < 5_000) return;
      if (
        useImportWizardStore.getState().isOpen ||
        useModalStore.getState().preferencesModalOpen ||
        useModalStore.getState().apiKeyModalOpen
      ) {
        return;
      }
      lastRefreshedAt = now;
      router.refresh();
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        markInactive();
        return;
      }
      if (document.visibilityState === 'visible') {
        handleFocusOrVisible();
      }
    };

    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('blur', markInactive);
      window.addEventListener('focus', handleFocusOrVisible);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('blur', markInactive);
        window.removeEventListener('focus', handleFocusOrVisible);
      };
    }
  }, [router]);

  const handleEditionDeleted = React.useCallback((deletedEditionId: string) => {
    const prune = (list: DisplayRepo[]) =>
      list.map((r) => {
        if (!r.editionGroup?.editions) return r;
        const hasTarget = r.editionGroup.editions.some((e) => e.id === deletedEditionId);
        if (!hasTarget) return r;
        const filtered = r.editionGroup.editions.filter((e) => e.id !== deletedEditionId);
        return {
          ...r,
          editionGroup: {
            ...r.editionGroup,
            editions: filtered,
          },
        };
      });
    setRepos((prev) => prune(prev));
    setMyRepos((prev) => prune(prev));
  }, []);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q !== null) {
      setSearchQuery(q);
    }
  }, [searchParams, setSearchQuery]);

  useEffect(() => {
    const s = searchParams.get('source');
    if (s === 'github' || s === 'webdoc' || s === 'all') {
      setSourceType(s);
    }
  }, [searchParams, setSourceType]);

  const handledImportRef = React.useRef<string | null>(null);

  useEffect(() => {
    const importRef = searchParams.get('import');
    if (!importRef || handledImportRef.current === importRef) return;
    const [refOwner, refRepo] = importRef.split('/').filter(Boolean);
    if (!refOwner || !refRepo) return;
    handledImportRef.current = importRef;
    requireApiKey(() => {
      openWizardForEdition(refOwner, refRepo);
    });
    const params = new URLSearchParams(window.location.search);
    params.delete('import');
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  }, [searchParams, openWizardForEdition, router]);

  const handleImportSubmit = (e?: React.FormEvent, customUrl?: string) => {
    if (e) e.preventDefault();
    requireAuth(() => {
      const targetUrl = (customUrl ?? inputUrl).trim();
      if (!targetUrl) {
        toastManager.add({ type: 'info', title: m.toast_repo_url_required() });
        return;
      }
      requireApiKey(() => {
        setUrl(targetUrl);
        openWizard();
      }, m.apikey_continue_parse());
    }, m.gate_reason_import_repo());
  };

  const handleExploreGuest = () => {
    useGuestStore.getState().enableGuestMode();
    toastManager.add({
      type: 'info',
      title: m.auth_guest_welcome_toast(),
    });
  };

  const handleSuggestionClick = (url: string) => {
    const matched = repos.find(r => {
      if (r.url && r.url.toLowerCase() === url.toLowerCase()) return true;
      if (r.owner && r.repo) {
        const fullSlug = `${r.owner}/${r.repo}`.toLowerCase();
        if (url.toLowerCase().includes(fullSlug)) return true;
        const pureRepo = r.repo.toLowerCase().replace(/-(docs|guide|tutorial)$/, '');
        if (pureRepo.length > 3 && url.toLowerCase().includes(pureRepo)) return true;
      }
      return false;
    });

    if (matched) {
      if (!effectiveLoggedInMode) {
        useGuestStore.getState().enableGuestMode();
        toastManager.add({
          type: 'info',
          title: m.auth_guest_welcome_toast(),
        });
      }
      router.push(`/docs/${matched.owner}/${matched.repo}`);
      return;
    }

    requireAuth(() => {
      setInputUrl(url);
      requireApiKey(() => {
        setUrl(url);
        openWizard();
      }, m.apikey_continue_parse());
    }, m.gate_reason_import_repo());
  };

  const handleToggleSave = (repo: DisplayRepo, autoFollow: boolean = true): Promise<void> => {
    const now = Date.now();
    const lastTs = lastSaveTriggerAtRef.current[repo.id] ?? 0;
    if (savingRepoIdsRef.current.has(repo.id) || now - lastTs < 500) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const allowed = requireAuth(async () => {
        if (savingRepoIdsRef.current.has(repo.id)) {
          resolve();
          return;
        }
        savingRepoIdsRef.current.add(repo.id);
        lastSaveTriggerAtRef.current[repo.id] = Date.now();
        try {
          const res = await api.post<{ fee?: number; alreadySaved?: boolean; signupGift?: number; balance?: number }>('/api/repos', {
            action: repo.isSaved ? 'unsave' : 'save',
            repositoryId: repo.id,
            autoFollow,
          });
          const effectiveSaved = repo.isSaved ? false : true;
          setRepos(prev =>
            prev.map(r =>
              r.id === repo.id
                ? {
                    ...r,
                    isSaved: effectiveSaved,
                    autoFollow: effectiveSaved ? autoFollow : undefined,
                    savedCount: res?.alreadySaved
                      ? r.savedCount
                      : effectiveSaved
                        ? (r.savedCount || 0) + 1
                        : Math.max(0, (r.savedCount || 0) - 1),
                  }
                : r
            )
          );
          setMyRepos(prev => {
            if (effectiveSaved) {
              if (prev.some(r => r.id === repo.id)) {
                return prev.map(r => (r.id === repo.id ? { ...r, isSaved: true, autoFollow } : r));
              }
              return [{ ...repo, isSaved: true, autoFollow }, ...prev];
            } else {
              return prev.filter(r => r.id !== repo.id);
            }
          });
          if (!repo.isSaved) {
            const paid = res?.fee ?? 0;
            const gift = res?.signupGift ?? 0;
            if (paid > 0 || typeof res?.balance === 'number') {
              useUserCreditsStore.getState().deductCredits(paid, res?.balance);
            }
            if (gift > 0) {
              useUserCreditsStore.getState().addCredits(gift);
            }
            useUserCreditsStore.getState().invalidate().catch(() => {});

            const descParts: string[] = [];
            if (paid > 0) descParts.push(m.shelf_fee_paid({ count: paid }));
            if (gift > 0) descParts.push(m.shelf_signup_gift({ count: gift }));
            toastManager.add({
              type: 'success',
              title: m.toast_project_added(),
              description: descParts.length > 0 ? descParts.join(' · ') : undefined,
            });
          } else {
            toastManager.add({ type: 'success', title: m.toast_project_removed() });
          }
        } catch (err: any) {
          if (err?.code === 'INSUFFICIENT_BALANCE') {
            toastManager.add({
              type: 'error',
              title: m.shelf_insufficient_title(),
              description: err?.message || m.shelf_insufficient_desc(),
              actionProps: {
                children: m.shelf_go_earn(),
                onClick: () => requireApiKey(() => openWizard(), m.apikey_continue_parse()),
              },
            });
            return;
          }
          toastManager.add({ type: 'error', title: m.toast_action_failed(), description: err?.message || m.common_retry_later() });
        } finally {
          savingRepoIdsRef.current.delete(repo.id);
          resolve();
        }
      }, m.gate_reason_save_shelf());

      if (!allowed) {
        resolve();
      }
    });
  };

  const handleToggleFavorite = (repo: DisplayRepo): Promise<void> => {
    if (favoritingRepoIdsRef.current.has(repo.id)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const allowed = requireAuth(async () => {
        if (favoritingRepoIdsRef.current.has(repo.id)) {
          resolve();
          return;
        }
        favoritingRepoIdsRef.current.add(repo.id);
        const prevFavorited = Boolean(repo.isFavorited);
        const prevCount = repo.favoriteCount ?? 0;
        const optimisticFavorited = !prevFavorited;
        const optimisticCount = Math.max(0, prevCount + (optimisticFavorited ? 1 : -1));

        const applyFavoritePatch = (list: DisplayRepo[], nextFavorited: boolean, nextCount: number) =>
          list.map((r) =>
            r.id === repo.id
              ? { ...r, isFavorited: nextFavorited, favoriteCount: nextCount }
              : r
          );

        setRepos((prev) => applyFavoritePatch(prev, optimisticFavorited, optimisticCount));
        setMyRepos((prev) => applyFavoritePatch(prev, optimisticFavorited, optimisticCount));

        try {
          const res = await api.post<{ isFavorited: boolean; favoriteCount: number }>(
            '/api/repositories/favorite',
            {
              repositoryId: repo.id,
              action: prevFavorited ? 'unfavorite' : 'favorite',
            }
          );

          const serverFavorited = Boolean(res?.isFavorited ?? optimisticFavorited);
          const reconcileCount = (r: DisplayRepo) => {
            const isMultiEdition = (r.editionGroup?.editions?.length ?? 1) > 1;
            if (!isMultiEdition && typeof res?.favoriteCount === 'number') {
              return res.favoriteCount;
            }
            return Math.max(0, prevCount + (serverFavorited ? 1 : prevFavorited ? -1 : 0));
          };

          setRepos((prev) =>
            prev.map((r) =>
              r.id === repo.id
                ? { ...r, isFavorited: serverFavorited, favoriteCount: reconcileCount(r) }
                : r
            )
          );
          setMyRepos((prev) =>
            prev.map((r) =>
              r.id === repo.id
                ? { ...r, isFavorited: serverFavorited, favoriteCount: reconcileCount(r) }
                : r
            )
          );

          toastManager.add({
            type: 'success',
            title: serverFavorited ? m.toast_favorite_added() : m.toast_favorite_removed(),
          });
        } catch (err: any) {
          setRepos((prev) => applyFavoritePatch(prev, prevFavorited, prevCount));
          setMyRepos((prev) => applyFavoritePatch(prev, prevFavorited, prevCount));
          toastManager.add({
            type: 'error',
            title: m.toast_action_failed(),
            description: err?.message || m.common_retry_later(),
          });
        } finally {
          favoritingRepoIdsRef.current.delete(repo.id);
          resolve();
        }
      }, m.dashboard_favorite_action());

      if (!allowed) {
        resolve();
      }
    });
  };

  const handleRemoveRepo = async (repo: DisplayRepo) => {
    requireAuth(async () => {
      try {
        const editions = repo.editionGroup?.editions;
        const idsToRemove = editions && editions.length > 0
          ? editions.map(e => e.id)
          : [repo.id];

        for (const id of idsToRemove) {
          if (repo.isPublic) {
            await api.post('/api/repos', {
              action: 'unsave',
              repositoryId: id,
            });
          } else {
            await api.delete(`/api/repos?id=${id}`);
          }
        }

        setRepos(prev =>
          prev.map(r =>
            idsToRemove.includes(r.id)
              ? { ...r, isSaved: false, savedCount: Math.max(0, (r.savedCount || 0) - 1) }
              : r
          )
        );
        setMyRepos(prev => prev.filter(r => !idsToRemove.includes(r.id) && r.id !== repo.id));
        toastManager.add({
          type: 'success',
          title: repo.isPublic ? m.toast_project_removed() : m.toast_project_deleted(),
        });
      } catch (err: any) {
        toastManager.add({
          type: 'error',
          title: m.common_delete_failed(),
          description: err?.message || m.common_retry_later(),
        });
      }
    });
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    repos.forEach(r => {
      const norm = normalizeCategory(r.category);
      if (norm && norm !== 'Others') set.add(norm);
    });
    const domainOrder: Record<string, number> = {
      'AI': 1, 'Systems': 2, 'Cloud': 3, 'Web': 4, 'Mobile': 5,
      'Gaming': 6, 'Hardware': 7, 'Finance': 8, 'Science': 9,
    };
    return Array.from(set).sort((a, b) => (domainOrder[a] ?? 99) - (domainOrder[b] ?? 99));
  }, [repos]);

  useEffect(() => {
    if (selectedCategory !== 'all' && categories.length > 0) {
      const normSelected = normalizeCategory(selectedCategory);
      if (!categories.includes(normSelected)) {
        setSelectedCategory('all');
      }
    }
  }, [categories, selectedCategory, setSelectedCategory]);

  const filteredRepos = useMemo(() => {
    return repos.filter(r => matchRepoWithSmartQuery(r, searchQuery, sourceType, selectedCategory));
  }, [repos, selectedCategory, searchQuery, sourceType]);

  return (
    <div
      className={`flex flex-col bg-theme-bg text-theme-foreground font-sans antialiased selection:bg-theme-primary/30 selection:text-theme-primary relative overflow-x-clip ${
        isLoggedInMode ? 'md:h-screen md:overflow-hidden min-h-screen' : 'min-h-screen'
      }`}
    >

      <div className="shrink-0 z-50">
        <HomeHeader initialUserId={initialUserId} />
      </div>

      <div className="shrink-0 z-40">
        <AnnouncementBanner announcements={announcements} />
      </div>

      {!effectiveLoggedInMode && !urlQuery && !urlHighlight ? (
        <main className="w-full flex-1 pb-0">
          <div className="relative w-full">
            <div className="sticky top-16 z-0 w-full min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-4 py-8">
              <HomeHeroSection
                inputUrl={inputUrl}
                setInputUrl={setInputUrl}
                handleImportSubmit={handleImportSubmit}
                handleSuggestionClick={handleSuggestionClick}
                onExploreGuest={handleExploreGuest}
                reposCount={repos.length}
              />
            </div>

            <div className="relative z-10 pt-4 sm:pt-8">
              <AgentDemoShowcase customRepoUrl={customRepo} />

              <div className="relative mt-24">
                <div className="absolute left-0 right-0 h-48 -top-48 bg-gradient-to-b from-transparent to-theme-bg pointer-events-none z-[-1]" />

                <div className="bg-theme-bg relative pt-16 z-10 border-t border-theme-border/0">
                  <BentoFeaturesSection repos={repos} />

                  <FaqAccordionSection />
                  <CtaBannerSection />
                </div>
              </div>
            </div>
          </div>
        </main>
      ) : (
        <div className="w-full flex-1 min-h-0 md:overflow-hidden">
          <UserDashboardView
            repos={repos}
            myRepos={myRepos}
            filteredRepos={filteredRepos}
            categories={categories}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            inputUrl={inputUrl}
            setInputUrl={setInputUrl}
            handleImportSubmit={handleImportSubmit}
            handleToggleSave={handleToggleSave}
            handleToggleFavorite={handleToggleFavorite}
            handleRemoveRepo={handleRemoveRepo}
            setMcpDialogRepo={handleOpenMcpDialog}
            isLoggedIn={effectiveLoggedInMode}
            isAuthenticated={Boolean(initialUserId)}
            hasPreferencesSet={hasPreferencesSet}
            initialActiveTab={activeTab}
            initialSort={sort}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            sourceType={sourceType}
            setSourceType={setSourceType}
            highlightRepo={urlHighlight}
            onEditionDeleted={handleEditionDeleted}
          />
        </div>
      )}

      {!effectiveLoggedInMode && !urlQuery && !urlHighlight && <HomeFooter />}

      {mcpDialogRepo && (
        <McpConnectDialog
          owner={mcpDialogRepo.owner}
          repo={mcpDialogRepo.repo}
          title={mcpDialogRepo.title}
          isOpen={!!mcpDialogRepo}
          onClose={() => setMcpDialogRepo(null)}
        />
      )}
    </div>
  );
}
