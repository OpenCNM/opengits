import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { TtlCache } from '@/lib/cache/ttl-cache';
import { readFileLocal, getFileContentLocalFirst } from '@/engine/tarball/archive-store';
import { detectLanguage } from '@/engine/languages';
import { ENGINE_CONFIG } from '@/lib/config';

export interface CodeFileResult {
  ok: boolean;
  found: boolean;
  filePath: string;
  sha: string;
  content: string;
  totalLines: number;
  language: string;
}

// 进程级内存缓存：TTL 5 分钟，容量 1,024，key 格式为 ${owner}/${repo}/${sha}/${filePath}
export const codeFileCache = new TtlCache<CodeFileResult>(5 * 60 * 1000, 1024);

export const GET = defineRoute<{ owner: string; repo: string }>({
  scope: 'GET /api/code/[owner]/[repo]/file',
  auth: 'none',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.publicReadDocsMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.publicReadDocsWindowMs,
  },
  handler: async ({ params, request }) => {
    const { owner, repo } = params;
    const url = new URL(request.url);
    const rawPath = url.searchParams.get('path')?.trim();
    const sha = url.searchParams.get('sha')?.trim() || undefined;

    if (!rawPath) {
      throw ApiError.badRequest('Path query parameter is required');
    }

    // 路径穿越防御与清洗
    const cleanPath = rawPath.replace(/^\.?\//, '').trim();
    if (cleanPath.includes('..') || cleanPath.startsWith('/') || cleanPath.startsWith('\\')) {
      throw ApiError.badRequest('Invalid or unsafe file path');
    }

    // 1. 优先从内存缓存获取仓库元数据
    const repository = await cachedDefaultBranchRepository(owner, repo);
    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }

    // 2. 鉴权：公开仓走快速通道；私有仓校验权限
    if (!repository.isPublic) {
      const session = await getSessionHelper();
      const userId = session?.user?.id;
      const isAuthorized = await verifyRepoAccessDirect(repository, userId);
      if (!isAuthorized) {
        throw ApiError.forbidden('Forbidden: You do not have access to this repository');
      }
    }

    const resolvedSha = sha || repository.gitSha || repository.branch || ENGINE_CONFIG.defaultBranch;
    const cacheKey = `${owner}/${repo}/${resolvedSha}/${cleanPath}`;
    const cached = codeFileCache.get(cacheKey);
    if (cached) {
      return ok<CodeFileResult>(cached);
    }

    // 3. 磁盘归档直读（0ms Fast-Path）
    let content: string | null = null;
    try {
      content = await readFileLocal(owner, repo, resolvedSha, cleanPath);
    } catch {
      content = null;
    }

    // 4. 未命中归档时网络回源兜底
    if (content === null) {
      try {
        content = await getFileContentLocalFirst(owner, repo, resolvedSha, cleanPath);
      } catch {
        content = null;
      }
    }

    if (content === null) {
      throw ApiError.notFound(`File not found: ${cleanPath}`);
    }

    const totalLines = content.split('\n').length;
    const langEntry = detectLanguage(cleanPath);
    const language = langEntry?.name || 'plaintext';

    const result: CodeFileResult = {
      ok: true,
      found: true,
      filePath: cleanPath,
      sha: resolvedSha,
      content,
      totalLines,
      language,
    };

    codeFileCache.set(cacheKey, result);
    return ok<CodeFileResult>(result);
  },
});
