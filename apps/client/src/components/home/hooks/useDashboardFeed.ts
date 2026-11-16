'use client';

import { useMemo } from 'react';
import { DisplayRepo } from '@/lib/home-data';
import { DASHBOARD_PAGINATION } from '@/lib/constants';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { calculateSourceTypeCounts, type DashboardSourceType } from '@/lib/search/smart-repo-search';

interface UseDashboardFeedOptions {
  repos: DisplayRepo[];
  myRepos?: DisplayRepo[];
  filteredRepos: DisplayRepo[];
  activeTab: string;
  currentPage: number;
  personalSearch: string;
  personalSourceType?: DashboardSourceType;
  pinnedOverrides?: Record<string, boolean>;
}

export function useDashboardFeed({
  repos,
  myRepos = [],
  filteredRepos,
  activeTab,
  currentPage,
  personalSearch,
  personalSourceType = 'all',
  pinnedOverrides = {},
}: UseDashboardFeedOptions) {
  const pageSize = DASHBOARD_PAGINATION.SINGLE_COLUMN_PAGE_SIZE;

  // Filter personal user repos prioritizing pinned repos
  const allPersonalRepos = useMemo(() => {
    const rawList = myRepos.length > 0 ? myRepos : repos.filter((r) => r.isSaved);
    const withOverrides = rawList.map((r) => {
      const isPinned = pinnedOverrides[r.id] ?? r.isPinned;
      return isPinned !== r.isPinned ? { ...r, isPinned } : r;
    });

    return [...withOverrides].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return 0;
    });
  }, [myRepos, repos, pinnedOverrides]);

  const personalSourceCounts = useMemo(
    () => calculateSourceTypeCounts(allPersonalRepos),
    [allPersonalRepos]
  );

  const personalRepos = useMemo(() => {
    const byType =
      personalSourceType === 'all'
        ? allPersonalRepos
        : allPersonalRepos.filter((r) =>
            personalSourceType === 'webdoc' ? isWebDocRepository(r) : !isWebDocRepository(r)
          );

    if (!personalSearch.trim()) return byType;
    const query = personalSearch.toLowerCase();
    return byType.filter(
      (r) =>
        (r.repo || '').toLowerCase().includes(query) ||
        (r.owner || '').toLowerCase().includes(query) ||
        resolveRepositoryDisplayName(r).toLowerCase().includes(query)
    );
  }, [allPersonalRepos, personalSourceType, personalSearch]);

  // Filter center public feed based on active tab with Diversity Interleave sorting
  const displayFeedRepos = useMemo(() => {
    if (activeTab === 'review') {
      return filteredRepos.filter(
        (r) => Boolean((r.relay && r.relay.done < r.relay.total) || r.hasUpdate)
      );
    }
    if (activeTab !== 'trending') return filteredRepos;

    const byScore = (a: DisplayRepo, b: DisplayRepo) => {
      const recDiff = (b.recScore || 0) - (a.recScore || 0);
      if (recDiff !== 0) return recDiff;
      const viewDiff = (b.views || 0) - (a.views || 0);
      if (viewDiff !== 0) return viewDiff;
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    };

    const buckets = new Map<string, DisplayRepo[]>();
    for (const repo of filteredRepos) {
      const type = (repo.repoProfile as any)?.repoType || 'docs';
      const list = buckets.get(type) || [];
      list.push(repo);
      buckets.set(type, list);
    }
    for (const [, list] of buckets) list.sort(byScore);
    const orderedTypes = [...buckets.entries()]
      .sort((x, y) => (y[1][0]?.recScore || 0) - (x[1][0]?.recScore || 0))
      .map(([t]) => t);
    const cursors = new Map(orderedTypes.map((t) => [t, 0]));
    const merged: DisplayRepo[] = [];
    let remaining = filteredRepos.length;
    while (remaining > 0) {
      let progressed = false;
      for (const type of orderedTypes) {
        const list = buckets.get(type)!;
        const idx = cursors.get(type)!;
        if (idx < list.length) {
          merged.push(list[idx]);
          cursors.set(type, idx + 1);
          remaining--;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return merged;
  }, [filteredRepos, activeTab]);

  const totalItems = displayFeedRepos.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const safeCurrentPage = Math.min(Math.max(currentPage, 1), totalPages);

  const paginatedFeedRepos = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize;
    return displayFeedRepos.slice(start, start + pageSize);
  }, [displayFeedRepos, safeCurrentPage, pageSize]);

  // 🎯 最近阅读/继续学习的仓库：
  // 1. 打通全域阅读足迹（涵盖公共教程与自建项目），不再局限于 personalRepos；
  // 2. 优先挑选有真实阅读足迹（lastReadAt 或 progress > 0）的仓库，按最近阅读时间 lastReadAt 绝对降序；
  // 3. 若无任何阅读记录，降级回退到个人项目首位 personalRepos[0]；若个人项目也为空，则返回 null 展示探索引导。
  const recentResumeRepo = useMemo(() => {
    const candidateMap = new Map<string, DisplayRepo>();
    for (const r of repos) {
      if (r?.id) candidateMap.set(r.id, r);
    }
    for (const r of allPersonalRepos) {
      if (r?.id) candidateMap.set(r.id, r);
    }
    const allCandidates = Array.from(candidateMap.values());

    const withReadRecord = allCandidates.filter(
      (r) => Boolean(r.lastReadAt) || (r.progress || 0) > 0
    );

    if (withReadRecord.length > 0) {
      return [...withReadRecord].sort((a, b) => {
        const timeA = a.lastReadAt ? new Date(a.lastReadAt).getTime() : 0;
        const timeB = b.lastReadAt ? new Date(b.lastReadAt).getTime() : 0;
        if (timeB !== timeA) return timeB - timeA;
        const progA = a.progress || 0;
        const progB = b.progress || 0;
        if (progB !== progA) return progB - progA;
        const upA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const upB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return upB - upA;
      })[0];
    }

    return allPersonalRepos.length > 0 ? allPersonalRepos[0] : null;
  }, [repos, allPersonalRepos]);

  return {
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
  };
}
