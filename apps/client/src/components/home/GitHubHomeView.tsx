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

  // Mode State: false = Logged-Out Public Homepage, true = Logged-In User Dashboard
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

  // 1. 首屏渲染遵循 SSR 确定性原则（规避 sessionStorage 导致的 Hydration Mismatch）
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

  // 2. 客户端首屏水合完成后，无缝恢复 KeepAlive 快照状态（无 URL 显式覆盖时）
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
  const lastSaveTriggerAtRef = React.useRef<Record<string, number>>({});

  useEffect(() => {
    setRepos(initialRepos);
  }, [initialRepos]);

  useEffect(() => {
    setMyRepos(initialMyRepos);
  }, [initialMyRepos]);

  // 视窗切回自愈 (Stale-While-Revalidate on Focus):
  // 用户在外部终端或其他标签页操作后切回本页面，自动对齐服务端最新事实，无需手动 F5 刷新
  useEffect(() => {
    let lastChecked = Date.now();
    const handleFocusOrVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        const now = Date.now();
        // 防抖：失活且距离上次刷新至少 5 秒才触发，避免高频切窗口频繁重查
        if (now - lastChecked >= 5_000) {
          lastChecked = now;
          router.refresh();
        }
      }
    };

    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', handleFocusOrVisible);
      window.addEventListener('focus', handleFocusOrVisible);
      return () => {
        document.removeEventListener('visibilitychange', handleFocusOrVisible);
        window.removeEventListener('focus', handleFocusOrVisible);
      };
    }
  }, [router]);

  // 讲法删除乐观更新：从当前内存状态即时剪除，0ms 消除已删讲法与多版本 Tag
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

  // 衍生讲法深链（文档页切换器「＋」跳转 ?import=owner/repo）：打开向导并预填 + 新讲法开关
  useEffect(() => {
    const importRef = searchParams.get('import');
    if (!importRef || handledImportRef.current === importRef) return;
    const [refOwner, refRepo] = importRef.split('/').filter(Boolean);
    if (!refOwner || !refRepo) return;
    handledImportRef.current = importRef;
    requireApiKey(() => {
      openWizardForEdition(refOwner, refRepo);
    });
    // 非破坏性清理 import 参数，严格保留现有 ?page= / ?sort= 等上下文
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
    // 1. 若推荐仓库已收录在库，访客可免登录直接进入阅读页（零门槛直达 Aha Moment）
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

    // 2. 若尚未收录，走标准导入流程（受登录网关守护）
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
          // 行级收藏：POST /api/repos {action, repositoryId, autoFollow}——按讲法行 connect/disconnect
          const res = await api.post<{ fee?: number; alreadySaved?: boolean; signupGift?: number; balance?: number }>('/api/repos', {
            action: repo.isSaved ? 'unsave' : 'save',
            repositoryId: repo.id,
            autoFollow,
          });
          // alreadySaved：重复点击幂等返回，不再虚增计数/插行（刷新即回弹的根源）
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
            // 第一性原理：主动驱动用户积分资产状态机流转与物理对齐
            const paid = res?.fee ?? 0;
            const gift = res?.signupGift ?? 0;
            if (paid > 0 || typeof res?.balance === 'number') {
              useUserCreditsStore.getState().deductCredits(paid, res?.balance);
            }
            if (gift > 0) {
              useUserCreditsStore.getState().addCredits(gift);
            }
            useUserCreditsStore.getState().invalidate().catch(() => {});

            // 收费透明化：实付（0 = 免费/豁免）与开户礼金都直接告诉用户
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
            // 余额不足：不只报文案，直接给「去赚积分」动线（toast action 按钮）
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
          // 透出服务端原因，无 message 才回落通用提示
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

  // 3. 自动收敛：当选中的分类在当前可用类目中已不存在任何教程时，自愈回退到 'all'，杜绝快照死锁在 0 项幽灵分类
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
      
      {/* 1. Header Navigation Component */}
      <div className="shrink-0 z-50">
        <HomeHeader initialUserId={initialUserId} />
      </div>

      {/* 2. Announcement Banner (Placed directly BELOW the top header) */}
      <div className="shrink-0 z-40">
        <AnnouncementBanner announcements={announcements} />
      </div>

      {/* 3. Public Homepage vs Logged-In User Dashboard */}
      {!effectiveLoggedInMode && !urlQuery && !urlHighlight ? (
        <main className="w-full flex-1 pb-0">
          <div className="relative w-full">
            {/* 1. Sticky Hero Layer (整屏完整呈现，居中黄金分割，随滚动原地下沉) */}
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

            {/* 2. Floating Demo Showcase Layer (首屏不遮挡 Hero，随滚动平滑向上升起覆盖) */}
            <div className="relative z-10 pt-4 sm:pt-8">
              <AgentDemoShowcase customRepoUrl={customRepo} />
              
              {/* Solid background starts smoothly with a gradient mask */}
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

      {/* 3. Footer */}
      {!effectiveLoggedInMode && !urlQuery && !urlHighlight && <HomeFooter />}

      {/* MCP Quick Connect Dialog Modal */}
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
