import { githubFetch, GithubNetworkError } from '@/lib/github/client';
import { ignoreBestEffort } from '@/lib/best-effort';
import { GITHUB_ENDPOINTS, ENGINE_CONFIG } from '@/lib/config';
import { resolveGithubToken } from '@/lib/github/token-resolver';
import { RepoProfile } from '@/engine/repo-sniffer';
import { ScoutPipelineError } from './types';

export interface RepoMeta {
  description: string;
  topics: string[];
  starCount: number;
  pushedAt: string | null;
  defaultBranch: string;
  upstream: { owner: string; repo: string } | null;
  repoSizeBytes: number;
  language?: string | null;
}

export interface ResolvedGithubContext {
  githubToken?: string;
  meta: RepoMeta;
}

async function assertGithubStatus(res: Response): Promise<void> {
  const status = res.status;
  if (status === 401) {
    throw new ScoutPipelineError({
      status: 'GITHUB_TOKEN_EXPIRED',
      error: '你绑定的 GitHub 授权已失效，请到设置中重新绑定后再导入',
      diagnosticDescription: '你绑定的 GitHub 授权已失效，请到设置中重新绑定后再导入。',
      suggestedFormat: 'https://github.com/owner/repo',
      httpStatus: 401,
      extra: { code: 'GITHUB_TOKEN_EXPIRED' },
    });
  }
  if (status === 404) {
    throw new ScoutPipelineError({
      status: 'NOT_FOUND',
      error: '未找到该 GitHub 仓库',
      diagnosticDescription: '仓库可能不存在、已被更名/删除，或属于未提供 Token 授权的私有仓库。',
      suggestedFormat: 'https://github.com/owner/repo',
      httpStatus: 404,
    });
  }
  if (status === 403) {
    const isRateLimit =
      res.headers.has('retry-after') ||
      res.headers.get('x-ratelimit-remaining') === '0';
    if (isRateLimit) {
      throw new ScoutPipelineError({
        status: 'RATE_LIMITED',
        error: 'GitHub API 请求频繁',
        diagnosticDescription: '触发了 GitHub API 限流频率控制。请稍后再试或在系统设置中配置 GITHUB_TOKEN。',
        suggestedFormat: 'https://github.com/owner/repo',
        httpStatus: 403,
      });
    }

    let errorDetail = '';
    try {
      const cloned = res.clone();
      const body = await cloned.json();
      errorDetail = body.message || '';
    } catch {
      ignoreBestEffort();
    }
    if (/rate limit|secondary rate|abuse/i.test(errorDetail)) {
      throw new ScoutPipelineError({
        status: 'RATE_LIMITED',
        error: 'GitHub API 请求频繁',
        diagnosticDescription: '触发了 GitHub API 限流频率控制。请稍后再试或在系统设置中配置 GITHUB_TOKEN。',
        suggestedFormat: 'https://github.com/owner/repo',
        httpStatus: 403,
      });
    }

    throw new ScoutPipelineError({
      status: 'FORBIDDEN',
      error: '无权限访问该 GitHub 仓库',
      diagnosticDescription: '仓库可能为私有仓库或当前 Token 无访问权限，请在设置中配置有效 GITHUB_TOKEN。',
      suggestedFormat: 'https://github.com/owner/repo',
      httpStatus: 403,
    });
  }
}

interface GithubRepoApiPayload {
  description?: string;
  topics?: string[];
  stargazers_count?: number;
  pushed_at?: string;
  updated_at?: string;
  size?: number;
  fork?: boolean;
  default_branch?: string;
  source?: GithubRepoUpstreamRef;
  parent?: GithubRepoUpstreamRef;
  language?: string | null;
}

interface GithubRepoUpstreamRef {
  owner?: { login?: string };
  name?: string;
}

export async function fetchRepoMeta(owner: string, repo: string, userId: string): Promise<ResolvedGithubContext> {
  const githubToken = await resolveGithubToken(userId);

  let repoRes: Response;
  try {
    repoRes = await githubFetch(`${GITHUB_ENDPOINTS.api}/repos/${owner}/${repo}`, {
      headers: { 'User-Agent': 'OpenGits-Engine' },
    }, { userId });
  } catch (err) {
    if (err instanceof GithubNetworkError) {
      throw new ScoutPipelineError({
        status: 'NETWORK',
        error: err.message,
        diagnosticDescription: '本机到 api.github.com 的连接中断（常见于 VPN/代理切换或网络抖动），系统已自动重试仍未恢复。请检查网络后重试。',
        suggestedFormat: 'https://github.com/owner/repo',
        httpStatus: 502,
      });
    }
    throw err;
  }

  await assertGithubStatus(repoRes);

  const meta: RepoMeta = {
    description: '',
    topics: [],
    starCount: 0,
    pushedAt: null,
    defaultBranch: ENGINE_CONFIG.defaultBranch,
    upstream: null,
    repoSizeBytes: 0,
    language: null,
  };

  if (repoRes.ok) {
    const repoData: GithubRepoApiPayload = await repoRes.json();
    meta.description = repoData.description || '';
    meta.topics = repoData.topics || [];
    meta.starCount = repoData.stargazers_count || 0;
    meta.pushedAt = repoData.pushed_at || repoData.updated_at || null;
    meta.repoSizeBytes = (Number(repoData.size) || 0) * 1024;
    meta.language = repoData.language || null;
    const forkUpstream = repoData.source || repoData.parent;
    if (repoData.fork && forkUpstream?.owner?.login && forkUpstream?.name) {
      meta.upstream = {
        owner: forkUpstream.owner.login,
        repo: forkUpstream.name,
      };
    }
    if (repoData.default_branch) {
      meta.defaultBranch = repoData.default_branch;
    }
  }

  return { githubToken, meta };
}

export function toRepoProfile(json: unknown): RepoProfile | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return json as RepoProfile;
}
