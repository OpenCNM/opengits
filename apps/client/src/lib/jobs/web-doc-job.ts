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
