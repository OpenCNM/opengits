import { GITHUB_ENDPOINTS } from '@/lib/config';
import { githubFetch } from '@/lib/github/client';
import { prisma } from '@/lib/db';

/**
 * 许可证门（发布预检）：提取并记录上游仓库的开源许可证（用于展示与元数据）。
 * 对于公开的 GitHub 仓库，即便未检测到标准 SPDX 许可证（如自定义版权、NOASSERTION 或无独立 LICENSE 文件），
 * 也视为公开仓库放行，不阻断发布；潜在版权侵权由平台举报与下架机制兜底。
 */

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

  // 缓存命中：已记录有效 SPDX 协议字符串
  if (typeof profile.license === 'string') {
    return { allowed: true, spdxId: profile.license };
  }

  // 缓存命中：此前探测为无或非标准许可证，公开 GitHub 仓库依然允许发布
  if (profile.license === null) {
    return { allowed: true, spdxId: null };
  }

  // 探测 GitHub license API（经统一咽喉：显式 token 优先，否则平台池——
  // 冷却/轮换/配额埋点与全站一致；原裸 fetch 只认 env 单 token）
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
    // fail-open：GitHub 不可达/限流时不阻塞共享（举报兜底）
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
    .catch(() => {});
}
