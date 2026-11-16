'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDashboardSnapshot, saveDashboardSnapshot } from '@/lib/stores/dashboard-keepalive-store';
import type { DashboardSourceType } from '@/lib/search/smart-repo-search';

export type DashboardFeedTab = 'all' | 'trending' | 'review';
export type { DashboardSourceType };

interface UseDashboardQueryParamsOptions {
  initialActiveTab?: string;
  initialSort?: string;
  selectedCategory: string;
  initialSourceType?: DashboardSourceType;
}

export function useDashboardQueryParams({
  initialActiveTab,
  initialSort,
  selectedCategory,
  initialSourceType,
}: UseDashboardQueryParamsOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 1. 解析初始 Tab：URL > 显式入参 > 默认 'all'
  const urlTab = searchParams.get('tab');
  const defaultTab: DashboardFeedTab =
    urlTab === 'review' || initialActiveTab === 'review'
      ? 'review'
      : urlTab === 'trending'
      ? 'trending'
      : 'all';

  // 2. 解析初始排序：URL > 显式入参 > 默认 'hot'
  const urlSort = searchParams.get('sort');
  const [currentSort, setCurrentSortState] = useState<string>(
    urlSort || initialSort || 'hot'
  );

  // 2.5 解析初始来源类型：URL ?source= > 显式入参 > 默认 'all'
  const urlSource = searchParams.get('source');
  const defaultSourceType: DashboardSourceType =
    urlSource === 'github' || urlSource === 'webdoc'
      ? urlSource
      : initialSourceType || 'all';
  const [sourceType, setSourceTypeState] = useState<DashboardSourceType>(defaultSourceType);

  // 3. 解析初始页码：URL ?page=X > 默认 1
  const urlPage = searchParams.get('page');
  const parsedUrlPage = urlPage ? parseInt(urlPage, 10) : NaN;
  const defaultPage = !isNaN(parsedUrlPage) && parsedUrlPage > 0 ? parsedUrlPage : 1;

  const [activeTab, setActiveTabState] = useState<DashboardFeedTab>(defaultTab);
  const [currentPage, setCurrentPageState] = useState<number>(defaultPage);

  // 同步 URL tab 变动（如外部导航 /?tab=trending）
  useEffect(() => {
    if (urlTab === 'review') {
      setActiveTabState('review');
    } else if (urlTab === 'trending') {
      setActiveTabState('trending');
    } else if (urlTab === 'all') {
      setActiveTabState('all');
    }
  }, [urlTab]);

  // 同步 URL sort 变动
  useEffect(() => {
    if (urlSort) {
      setCurrentSortState(urlSort);
    }
  }, [urlSort]);

  // 同步 URL source 变动
  useEffect(() => {
    if (urlSource === 'github' || urlSource === 'webdoc') {
      setSourceTypeState(urlSource);
    } else if (urlSource === 'all') {
      setSourceTypeState('all');
    }
  }, [urlSource]);

  // 记录最近一次已应用的 URL page 参数，防止内部翻页时被外部滞后的 searchParams 覆盖死锁
  const lastAppliedUrlPageRef = useRef<string | null>(searchParams.get('page'));

  // 同步外部路由导航中的 ?page 变动
  useEffect(() => {
    const rawPage = searchParams.get('page');
    // 若 Next.js 内部 searchParams 滞后于 window.location.href（如 replaceState 静默替换），以 window.location 为准
    const windowPage = typeof window !== 'undefined' && window.location?.href
      ? new URL(window.location.href).searchParams.get('page')
      : null;
    const effectivePage = rawPage || windowPage;

    if (effectivePage !== lastAppliedUrlPageRef.current) {
      lastAppliedUrlPageRef.current = effectivePage;
      if (effectivePage) {
        const p = parseInt(effectivePage, 10);
        if (!isNaN(p) && p > 0) {
          setCurrentPageState(p);
          saveDashboardSnapshot({ currentPage: p });
        }
      } else {
        const snap = getDashboardSnapshot();
        const fallbackPage = snap.savedAt > 0 && snap.currentPage > 1 ? snap.currentPage : 1;
        setCurrentPageState(fallbackPage);
        saveDashboardSnapshot({ currentPage: fallbackPage });
      }
    }
  }, [searchParams]);

  // 原生 popstate 监听：覆盖 Next.js 客户端历史导航边缘情况
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const handlePopState = () => {
      const url = new URL(window.location.href);
      const rawPage = url.searchParams.get('page');
      if (rawPage !== lastAppliedUrlPageRef.current) {
        lastAppliedUrlPageRef.current = rawPage;
        const p = rawPage ? parseInt(rawPage, 10) : 1;
        const safeP = !isNaN(p) && p > 0 ? p : 1;
        setCurrentPageState(safeP);
        saveDashboardSnapshot({ currentPage: safeP });
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // 4. 包装 setCurrentPage：保证 Vue 级 KeepAlive 同步与 URL history 静默替换
  const setCurrentPage: React.Dispatch<React.SetStateAction<number>> = useCallback((action) => {
    setCurrentPageState((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      const safeNext = Math.max(1, next);
      const targetPageStr = safeNext > 1 ? String(safeNext) : null;
      lastAppliedUrlPageRef.current = targetPageStr;

      // 持久化到 KeepAlive 内存与会话缓存
      saveDashboardSnapshot({ currentPage: safeNext });

      // 静默同步到浏览器 URL（不触发 RSC 刷新，零卡顿）
      if (typeof window !== 'undefined' && window.location?.href && typeof window.history?.replaceState === 'function') {
        const url = new URL(window.location.href);
        if (safeNext > 1) {
          url.searchParams.set('page', String(safeNext));
        } else {
          url.searchParams.delete('page');
        }
        window.history.replaceState(window.history.state, '', url.toString());
      }

      return safeNext;
    });
  }, []);

  const setActiveTab = useCallback((nextTab: DashboardFeedTab) => {
    setActiveTabState(nextTab);
    saveDashboardSnapshot({ activeTab: nextTab });
  }, []);

  const setSourceType = useCallback((nextSource: DashboardSourceType) => {
    setSourceTypeState(nextSource);
    saveDashboardSnapshot({ sourceType: nextSource });
    setCurrentPage(1);
    const params = new URLSearchParams(window.location.search);
    if (nextSource === 'all') {
      params.delete('source');
    } else {
      params.set('source', nextSource);
    }
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  }, [router, setCurrentPage]);

  // 5. 防止初始化挂载时的初始 Effect 将已恢复的页码刷成 1
  // 第一性原理对齐：优先从快照预热 prevRef，使首屏客户端水合过程中匹配快照的参数对齐不被误判为「用户主动切换」
  const snapshotOnMount = getDashboardSnapshot();
  const initialCategory = snapshotOnMount.savedAt > 0 && snapshotOnMount.selectedCategory ? snapshotOnMount.selectedCategory : selectedCategory;
  const initialTab = snapshotOnMount.savedAt > 0 && snapshotOnMount.activeTab ? snapshotOnMount.activeTab : activeTab;
  const initialSource = snapshotOnMount.savedAt > 0 && snapshotOnMount.sourceType ? snapshotOnMount.sourceType : sourceType;

  const isInitialMount = useRef(true);
  const prevCategoryRef = useRef(initialCategory);
  const prevTabRef = useRef(initialTab);
  const prevSourceRef = useRef(initialSource);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      const snap = getDashboardSnapshot();
      prevCategoryRef.current = (snap.savedAt > 0 && snap.selectedCategory && snap.selectedCategory !== 'all')
        ? snap.selectedCategory
        : selectedCategory;
      prevTabRef.current = (snap.savedAt > 0 && snap.activeTab && snap.activeTab !== 'all')
        ? snap.activeTab
        : activeTab;
      prevSourceRef.current = (snap.savedAt > 0 && snap.sourceType && snap.sourceType !== 'all')
        ? snap.sourceType
        : sourceType;
      return;
    }

    // 仅当用户主动切换分类、Tab 或来源时才重置到第一页
    if (
      prevCategoryRef.current !== selectedCategory ||
      prevTabRef.current !== activeTab ||
      prevSourceRef.current !== sourceType
    ) {
      prevCategoryRef.current = selectedCategory;
      prevTabRef.current = activeTab;
      prevSourceRef.current = sourceType;
      setCurrentPage(1);
    }
  }, [selectedCategory, activeTab, sourceType, setCurrentPage]);

  // 6. 挂载后安全水合 KeepAlive 快照（保证 SSR 首帧一致性，杜绝 Hydration Mismatch）
  useEffect(() => {
    const snapshot = getDashboardSnapshot();
    if (snapshot.savedAt > 0) {
      if (!urlTab && snapshot.activeTab && snapshot.activeTab !== 'all') {
        setActiveTabState(snapshot.activeTab);
        prevTabRef.current = snapshot.activeTab;
      }
      if (!urlSort && snapshot.currentSort && snapshot.currentSort !== 'hot') {
        setCurrentSortState(snapshot.currentSort);
      }
      if (!urlSource && snapshot.sourceType && snapshot.sourceType !== 'all') {
        setSourceTypeState(snapshot.sourceType);
        prevSourceRef.current = snapshot.sourceType;
      }
      if (isNaN(parsedUrlPage) && snapshot.currentPage > 1) {
        setCurrentPageState(snapshot.currentPage);
        lastAppliedUrlPageRef.current = String(snapshot.currentPage);
        // 静默同步回浏览器 URL，确保后续第三方授权（GitHub OAuth）携带真实页码返回
        if (typeof window !== 'undefined' && window.location?.href && typeof window.history?.replaceState === 'function') {
          const url = new URL(window.location.href);
          url.searchParams.set('page', String(snapshot.currentPage));
          window.history.replaceState(window.history.state, '', url.toString());
        }
      }
      if (snapshot.selectedCategory && snapshot.selectedCategory !== 'all') {
        prevCategoryRef.current = snapshot.selectedCategory;
      }
    }
  }, [urlTab, urlSort, urlSource, parsedUrlPage]);

  const handleSortChange = (newSort: string) => {
    saveDashboardSnapshot({ currentSort: newSort });
    setCurrentSortState(newSort);
    const params = new URLSearchParams(window.location.search);
    if (newSort === 'hot') {
      params.delete('sort');
    } else {
      params.set('sort', newSort);
    }
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : '/');
  };

  return {
    activeTab,
    setActiveTab,
    currentSort,
    handleSortChange,
    sourceType,
    setSourceType,
    currentPage,
    setCurrentPage,
  };
}
