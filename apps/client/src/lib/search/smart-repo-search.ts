import { DisplayRepo } from '@/lib/home-data';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { isUnderPrefix } from '@/lib/import-wizard/webdoc-scope';
import { normalizeCategory } from '@/lib/constants';

export type DashboardSourceType = 'all' | 'github' | 'webdoc';

export interface DissectedQuery {
  raw: string;
  isUrl: boolean;
  cleanQuery: string;
  candidateOwner?: string;
  candidateRepo?: string;
  hostname?: string;
}

/**
 * 智能解构搜索输入：判断是否为 URL / GitHub 路径，并抽取潜在的 owner/repo 或站点信息
 */
export function dissectSearchQuery(input: string): DissectedQuery {
  const raw = (input || '').trim();
  if (!raw) {
    return { raw: '', isUrl: false, cleanQuery: '' };
  }

  // 1. 判断是否带有 http://, https://, 或 github.com/
  let parseableUrl = raw;
  if (/^github\.com\//i.test(raw)) {
    parseableUrl = `https://${raw}`;
  }

  try {
    if (/^https?:\/\//i.test(parseableUrl)) {
      const parsed = new URL(parseableUrl);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '');
      const segments = pathname.split('/').filter(Boolean);

      if (hostname === 'github.com' && segments.length >= 2) {
        return {
          raw,
          isUrl: true,
          cleanQuery: segments.slice(0, 2).join('/'),
          candidateOwner: segments[0],
          candidateRepo: segments[1].replace(/\.git$/i, ''),
          hostname,
        };
      }

      // 官方文档或其他 Web URL
      const candidateRepo = segments[0] || '';
      return {
        raw,
        isUrl: true,
        cleanQuery: segments.join(' ') || hostname,
        candidateRepo,
        hostname,
      };
    }
  } catch {
    // 非合法 URL，进入 owner/repo 格式判定
  }

  // 2. 判断是否为裸 owner/repo（如 "karpathy/llm.c" 或 "vllm-project/vllm"）
  const ownerRepoMatch = raw.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (ownerRepoMatch) {
    return {
      raw,
      isUrl: false,
      cleanQuery: raw,
      candidateOwner: ownerRepoMatch[1],
      candidateRepo: ownerRepoMatch[2],
    };
  }

  return {
    raw,
    isUrl: false,
    cleanQuery: raw,
  };
}

const GENERIC_CODE_HOSTS = new Set(['github.com', 'www.github.com', 'gitlab.com', 'gitee.com']);

function parseNormalizedUrl(rawUrl: string): URL | null {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(withScheme);
  } catch {
    // 容错降级: 非法 URL 格式在解析阶段返回 null，由调用方执行 fail-closed 过滤
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '');
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

function getRepoProfile(repo: DisplayRepo): Record<string, unknown> {
  return (repo.repoProfile && typeof repo.repoProfile === 'object' ? repo.repoProfile : {}) as Record<string, unknown>;
}

function extractGithubSlugFromUrl(rawUrl: string): { owner: string; repo: string } | null {
  const parsed = parseNormalizedUrl(rawUrl);
  if (!parsed || !GENERIC_CODE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return {
    owner: segments[0].toLowerCase(),
    repo: segments[1].replace(/\.git$/i, '').toLowerCase(),
  };
}

/**
 * URL 查询严格闭环匹配：
 * - GitHub 链接：严格按解析出的 owner/repo 匹配仓名与 originalUrl；
 * - 独立 WebDoc 站点链接（如 https://coss.com/ui/docs）：严格按解析后的规范化域名（及 allowedPrefixes）匹配，
 *   绝不回退到路径词（如 "ui" + "docs"）全文子串模糊搜索，杜绝误匹配无关项目。
 */
function matchUrlQueryAgainstRepo(repo: DisplayRepo, dissected: DissectedQuery): boolean {
  const profile = getRepoProfile(repo);
  const origUrl = typeof profile.originalUrl === 'string' ? profile.originalUrl.trim() : '';

  if (dissected.candidateOwner && dissected.candidateRepo) {
    const ownerLower = repo.owner.toLowerCase();
    const repoLower = repo.repo.toLowerCase();
    const candOwnerLower = dissected.candidateOwner.toLowerCase();
    const candRepoLower = dissected.candidateRepo.toLowerCase();

    if (ownerLower === candOwnerLower && repoLower === candRepoLower) {
      return true;
    }

    const origGitSlug = origUrl ? extractGithubSlugFromUrl(origUrl) : null;
    return Boolean(origGitSlug && origGitSlug.owner === candOwnerLower && origGitSlug.repo === candRepoLower);
  }

  const queryParsed = parseNormalizedUrl(dissected.raw);
  if (!queryParsed || !dissected.hostname) return false;

  if (GENERIC_CODE_HOSTS.has(dissected.hostname)) {
    const segments = queryParsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    return segments.length === 1 && repo.owner.toLowerCase() === segments[0].toLowerCase();
  }

  const origParsed = origUrl ? parseNormalizedUrl(origUrl) : null;
  if (!origParsed || normalizeHostname(origParsed.hostname) !== normalizeHostname(dissected.hostname)) {
    return false;
  }

  const queryPath = normalizePathname(queryParsed.pathname);
  const rawPrefixes = Array.isArray(profile.allowedPrefixes)
    ? profile.allowedPrefixes.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const normalizedPrefixes = rawPrefixes.map((p) => normalizePathname(p.startsWith('/') ? p : `/${p}`));

  if (normalizedPrefixes.length > 0 && !normalizedPrefixes.includes('/') && queryPath !== '/') {
    return normalizedPrefixes.some(
      (prefix) => isUnderPrefix(queryPath, prefix) || isUnderPrefix(prefix, queryPath),
    );
  }

  return true;
}

/**
 * 判断单条仓库是否满足来源、分类与智能搜索词的联合匹配
 */
export function matchRepoWithSmartQuery(
  repo: DisplayRepo,
  query: string,
  sourceType: DashboardSourceType = 'all',
  selectedCategory: string = 'all'
): boolean {
  const isWebDoc = isWebDocRepository(repo);

  // 1. 来源过滤（SourceType 正交判定）
  if (sourceType === 'github' && isWebDoc) return false;
  if (sourceType === 'webdoc' && !isWebDoc) return false;

  // 2. 领域分类过滤（Category 双向归一判定）
  if (selectedCategory !== 'all' && normalizeCategory(repo.category) !== normalizeCategory(selectedCategory)) {
    return false;
  }

  // 3. 搜索关键词过滤
  const trimmed = query.trim();
  if (!trimmed) return true;

  const dissected = dissectSearchQuery(trimmed);

  // 3.1 完整 URL 查询 fail-closed：命中即真，未命中直接 false，严禁泄漏至全文关键词模糊匹配
  if (dissected.isUrl) {
    return matchUrlQueryAgainstRepo(repo, dissected);
  }

  // 3.2 裸 owner/repo（如 "karpathy/llm.c"）优先做项目关联匹配
  if (dissected.candidateOwner && dissected.candidateRepo) {
    const ownerLower = repo.owner.toLowerCase();
    const repoLower = repo.repo.toLowerCase();
    const candOwnerLower = dissected.candidateOwner.toLowerCase();
    const candRepoLower = dissected.candidateRepo.toLowerCase();

    if (ownerLower === candOwnerLower && repoLower === candRepoLower) {
      return true;
    }
    if (ownerLower.includes(candOwnerLower) && repoLower.includes(candRepoLower)) {
      return true;
    }

    const profile = getRepoProfile(repo);
    const origUrl = typeof profile.originalUrl === 'string' ? profile.originalUrl.trim() : '';
    const origGitSlug = origUrl ? extractGithubSlugFromUrl(origUrl) : null;
    if (origGitSlug && origGitSlug.owner === candOwnerLower && origGitSlug.repo === candRepoLower) {
      return true;
    }
  }

  // 3.3 常规多字段模糊子串穿透匹配
  const qLower = (dissected.cleanQuery || trimmed).toLowerCase();
  const searchTerms = qLower.split(/\s+/).filter(Boolean);

  const displayTitle = resolveRepositoryDisplayName(repo).toLowerCase();
  const repoName = (repo.repo || '').toLowerCase();
  const ownerName = (repo.owner || '').toLowerCase();
  const rawTitle = (repo.title || '').toLowerCase();
  const desc = (repo.description || '').toLowerCase();
  const tagsStr = (repo.tags || []).map((t) => `${t} #${t}`).join(' ').toLowerCase();

  const searchableText = `${displayTitle} ${repoName} ${ownerName} ${rawTitle} ${desc} ${tagsStr}`;

  // 必须满足输入的所有检索 term（空格分隔分词与连词，兼容用户带 # 搜索标签或普通文本）
  return searchTerms.every((term) => {
    if (searchableText.includes(term)) return true;
    const strippedTerm = term.replace(/^#+/, '');
    return strippedTerm ? searchableText.includes(strippedTerm) : false;
  });
}

/**
 * 统计各来源类型的数量（用于在筛选胶囊中展示数字）
 */
export function calculateSourceTypeCounts(repos: DisplayRepo[]): {
  all: number;
  github: number;
  webdoc: number;
} {
  let github = 0;
  let webdoc = 0;
  for (const repo of repos) {
    if (isWebDocRepository(repo)) {
      webdoc++;
    } else {
      github++;
    }
  }
  return {
    all: repos.length,
    github,
    webdoc,
  };
}
