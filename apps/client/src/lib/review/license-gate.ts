import { GITHUB_ENDPOINTS } from '@/lib/config';
import { ignoreBestEffort } from '@/lib/best-effort';
import { githubFetch } from '@/lib/github/client';
import { prisma } from '@/lib/db';

// Fails open on GitHub API outages so public repo sharing is not blocked; copyright reports handle takedowns.

export interface LicenseVerdict {
  allowed: boolean;
  spdxId: string | null;
  reason?: string;
}

interface RepoWithProfile {
  id: string;
  owner: string;
  repo: string;
  repoProfile: unknown;
}

export async function checkPublishLicense(repository: RepoWithProfile, token?: string): Promise<LicenseVerdict> {
  const profile = (repository.repoProfile as Record<string, unknown> | null) ?? {};

  if (typeof profile.license === 'string') {
    return { allowed: true, spdxId: profile.license };
  }

  if (profile.license === null) {
    return { allowed: true, spdxId: null };
  }

  try {
    const res = await githubFetch(
      `${GITHUB_ENDPOINTS.api}/repos/${repository.owner}/${repository.repo}/license`,
      {
        signal: AbortSignal.timeout(8000),
      },
      token ? { explicitToken: token } : {},
    );
    if (res.status === 404) {
      await cacheLicense(repository, null);
      return { allowed: true, spdxId: null, reason: '未检测到独立 LICENSE 文件，作为公开仓库放行' };
    }
    if (!res.ok) throw new Error(`license api ${res.status}`);
    const data = (await res.json()) as { license?: { spdx_id?: string | null } };
    const spdxId = data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : null;
    await cacheLicense(repository, spdxId);
    return { allowed: true, spdxId };
  } catch (err) {
    console.warn('[license-gate] probe failed, failing open:', err instanceof Error ? err.message : err);
    return { allowed: true, spdxId: null, reason: '许可证探测不可用，本次放行' };
  }
}

async function cacheLicense(repository: RepoWithProfile, spdxId: string | null): Promise<void> {
  const profile = (repository.repoProfile as Record<string, unknown> | null) ?? {};
  await prisma.repository
    .update({
      where: { id: repository.id },
      data: { repoProfile: { ...profile, license: spdxId } as any },
    })
    .catch(ignoreBestEffort);
}
