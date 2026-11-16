// WebDoc 源轻量工具（2026-10 收口）：
// - WEB_DOC_OWNER：网页源虚拟属主常量（导入向导/审核发布链消费）
// - probeWebDocUpstream：update-check 路由的上游差分探测（etag/sitemap 轻探测）
//
// 原执行内核（runWebDocImportJob / runWebDocSyncJob，Crawlee 梯子与事务落库）
// 已随 Node in-process 执行器双轨退役——Go internal/webdoc 领域包全量接管
// （FastPath BFS → Firecrawl → Fail-Closed 终局梯子），编排随 Go body 闭环。

import { WEB_DOC_OWNER } from '@/lib/constants';
import { callSidecar } from '@/lib/sidecar-client';
import { webDocEngine } from '@/engine/web-doc';

export { WEB_DOC_OWNER };
export async function probeWebDocUpstream(
  repository: { id: string; owner: string; repo: string; branch: string; upstreamEtag: string | null; repoProfile: unknown }
): Promise<boolean> {
  const repoProfile = (repository.repoProfile as Record<string, unknown>) || {};
  const originalUrl = repoProfile.originalUrl as string | undefined;
  if (!originalUrl || repoProfile.sourceType !== 'web') return false;

  const diff = await webDocEngine.detectDiff(originalUrl, {
    etag: repository.upstreamEtag || undefined,
    sitemapLastMod: (repoProfile.sitemapLastModMap as Record<string, string>) || {},
  });

  await callSidecar(
    '/v1/repos/patch',
    {
      id: repository.id,
      hasUpstreamUpdate: diff.hasChanges,
      touchUpstreamCheckedAt: true,
      upstreamEtag: diff.etag || null,
      clearUpstreamEtag: !diff.etag,
      ...(diff.sitemapLastModMap
        ? { repoProfile: { ...repoProfile, sitemapLastModMap: diff.sitemapLastModMap } }
        : {}),
    },
    { label: 'web-doc-job-patch-diff' }
  );
  return diff.hasChanges;
}
