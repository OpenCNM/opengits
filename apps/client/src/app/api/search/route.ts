import { parseGithubUrl } from '@/lib/url-parser';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import {
  executeSidecarUnifiedSearch,
  type SidecarUnifiedSearchResultItem,
} from '@/engine/search-driver';
import { callSidecar } from '@/lib/sidecar-client';

export type SearchResultItem = SidecarUnifiedSearchResultItem;

// 公开搜索：匿名可查（仅命中共享文档 ownerUserId=null），登录后扩展到本人私有文档
// 单后端收编：全量数据库多表检索、图谱概念匹配、分块聚合与评分排序 100% 委托 Go worker-sidecar
export const GET = defineRoute({
  scope: 'GET /api/search',
  handler: async ({ request, userId }) => {
    const { searchParams } = new URL(request.url);
    const owner = searchParams.get('owner');
    const repo = searchParams.get('repo');
    const rawQuery = searchParams.get('q')?.trim() || '';

    if (!rawQuery) {
      // 空查询返回平台热门公开教程（搜索框初始推荐；动态取数，杜绝写死仓库名）
      let hotRepos: Array<{ id: string; owner: string; repo: string }> = [];
      try {
        const sidecarRes = await callSidecar<{
          ok: boolean;
          repos: Array<{ id: string; owner: string; repo: string }>;
        }>(
          '/v1/search/featured',
          { limit: ENGINE_CONFIG.pagination.searchFeaturedLimit },
          { label: 'search /v1/search/featured', timeoutMs: 3_000 }
        );
        if (sidecarRes.ok && Array.isArray(sidecarRes.repos)) {
          hotRepos = sidecarRes.repos;
        }
      } catch (err) {
        console.warn('[api/search] sidecar featured search failed, returning empty list:', err);
      }

      return ok(
        hotRepos.map((r) => ({
          id: `featured-${r.id}`,
          type: 'featured_tutorial' as const,
          isIngested: true,
          title: `${r.owner}/${r.repo}`,
          description: '',
          owner: r.owner,
          repo: r.repo,
          url: `/docs/${r.owner}/${r.repo}`,
          score: 0,
        }))
      );
    }

    // 1. Smart GitHub URL & owner/repo format detection
    const parsedUrl = parseGithubUrl(rawQuery);
    const exactOwner = parsedUrl?.owner;
    const exactRepo = parsedUrl?.repo;

    // 2. 统一委托 Go worker-sidecar 原生执行混合检索（涵盖 Mode A 单仓与 Mode B 全局）
    try {
      const results = await executeSidecarUnifiedSearch({
        query: rawQuery,
        rawQuery,
        owner: owner || undefined,
        repo: repo || undefined,
        userId,
        exactOwner,
        exactRepo,
        limit: 15,
      });

      return ok(results);
    } catch (err) {
      console.warn('[api/search] sidecar unified search failed, returning empty list:', err);
      return ok([]);
    }
  },
});
