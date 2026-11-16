/**
 * apps/client/src/app/api/search/index/[owner]/[repo]/route.ts
 *
 * Safe, High-Performance Binary Search Index Stream Endpoint.
 *
 * Delivers OGIS v1 pre-built binary search indexes:
 * - Public Repo Fast-Path: bypass getSessionHelper() completely
 * - Direct authentication & authorization (verifyRepoAccessDirect) for private repos
 * - GitSha ETag & Immutable 1-Year Disk Cache Control
 * - Transparent 304 Not Modified negotiation
 * - Zero-V8-Heap stream proxy via Go worker-sidecar (executeSidecarAssetServe + pipeSidecarAssetResponse)
 * - Single-Writer & Self-Healing: JIT index build on sidecar 404 Miss with retry
 * - Fail-Open fallback to Node getOrGenerateRepoBinaryIndex
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { ENGINE_CONFIG } from '@/lib/config';
import { executeSidecarAssetServe, pipeSidecarAssetResponse } from '@/engine/asset-driver';
import { buildRepoBinaryIndexViaSidecar } from '@/engine/search-driver';
import { getOrGenerateRepoBinaryIndex } from '@/lib/search/binary-index-service';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  try {
    const { owner, repo } = await params;

    // 1. 优先从进程内 TTL 缓存获取仓库元数据（未命中再查 DB）
    const cachedRepo = await cachedDefaultBranchRepository(owner, repo);
    const repository =
      cachedRepo ||
      (await prisma.repository.findFirst({
        where: { owner, repo },
        select: {
          id: true,
          isPublic: true,
          branch: true,
          gitSha: true,
        },
      }));

    if (!repository) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    // 2. 鉴权与限流：公开仓走快速通道（Fast-Path），彻底跳过 getSessionHelper()
    if (repository.isPublic) {
      if (
        !(await checkRateLimit(
          `search-index:ip:${clientIpFromRequest(req.headers)}`,
          ENGINE_CONFIG.rateLimit.publicReadAssetsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadAssetsWindowMs,
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }
    } else {
      const session = await getSessionHelper();
      const userId = session?.user?.id;

      if (
        !(await checkRateLimit(
          `search-index:${userId ? `user:${userId}` : `ip:${clientIpFromRequest(req.headers)}`}`,
          ENGINE_CONFIG.rateLimit.publicReadAssetsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadAssetsWindowMs,
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }

      const isAuthorized = await verifyRepoAccessDirect(repository, userId);
      if (!isAuthorized) {
        return NextResponse.json(
          { error: 'Forbidden: You do not have access to this repository' },
          { status: 403 },
        );
      }
    }

    const gitSha = repository.gitSha || 'head';
    const etag = `"${gitSha}"`;

    const cacheControl = repository.isPublic
      ? 'public, max-age=31536000, immutable'
      : 'private, max-age=3600';

    const extraHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
      'X-OGIS-Version': '1',
      'X-OGIS-GitSha': gitSha,
    };

    // 3. HTTP 条件请求 (304 Not Modified)
    const ifNoneMatch = req.headers.get('if-none-match');
    if (ifNoneMatch) {
      const matchCandidates = ifNoneMatch
        .split(',')
        .map((s) => s.trim().replace(/^W\//, ''));
      if (
        matchCandidates.includes(etag) ||
        matchCandidates.includes(gitSha) ||
        ifNoneMatch.trim() === '*'
      ) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': cacheControl,
            'X-OGIS-Version': '1',
            'X-OGIS-GitSha': gitSha,
          },
        });
      }
    }

    // 4. 优先通过 Go worker-sidecar 零拷贝流式直出
    const assetPath = `search-index-${gitSha}.bin`;
    let sidecarRes = await executeSidecarAssetServe({
      owner,
      repo,
      path: assetPath,
      sha: repository.gitSha,
      branch: repository.branch,
      headers: req.headers,
      method: req.method,
    });

    // 4.1 Sidecar 首次 404 (索引尚未生成)：触发 JIT 构建并重试直出
    if (sidecarRes && sidecarRes.status === 404) {
      try {
        const buildRes = await buildRepoBinaryIndexViaSidecar(repository.id);
        if (buildRes?.built) {
          sidecarRes = await executeSidecarAssetServe({
            owner,
            repo,
            path: assetPath,
            sha: repository.gitSha,
            branch: repository.branch,
            headers: req.headers,
            method: req.method,
          });
        }
      } catch (err) {
        console.warn(`[search-index-route] sidecar JIT build failed for repo ${repository.id}:`, err);
      }
    }

    if (
      sidecarRes &&
      (sidecarRes.status === 200 ||
        sidecarRes.status === 206 ||
        sidecarRes.status === 304 ||
        sidecarRes.status === 301 ||
        sidecarRes.status === 302)
    ) {
      return pipeSidecarAssetResponse(sidecarRes, extraHeaders);
    }

    // 5. Fail-Open: 回退调用 Node 现场生成并返回
    const indexResult = await getOrGenerateRepoBinaryIndex(
      owner,
      repo,
      repository.gitSha ?? undefined,
    );
    if (!indexResult) {
      return NextResponse.json({ error: 'Failed to generate search index' }, { status: 500 });
    }

    const finalGitSha = indexResult.gitSha || gitSha;
    const finalHeaders = {
      ...extraHeaders,
      ETag: `"${finalGitSha}"`,
      'X-OGIS-GitSha': finalGitSha,
    };

    return new NextResponse(new Uint8Array(indexResult.buffer), {
      status: 200,
      headers: finalHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
