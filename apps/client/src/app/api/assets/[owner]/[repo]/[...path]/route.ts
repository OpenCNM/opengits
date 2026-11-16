import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';
import { CACHE_CONTROL_STRATEGIES, ENGINE_CONFIG, GITHUB_ENDPOINTS } from '@/lib/config';
import { getRepoAssetsDir } from '@/lib/storage/assets-paths';
import { putAsset, getAsset, assetObjectKey, activeStorageDriverName } from '@/lib/storage/assets-store';
import { githubFetch } from '@/lib/github/client';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { executeSidecarAssetServe, pipeSidecarAssetResponse } from '@/engine/asset-driver';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string; path: string[] }> }
) {
  try {
    const { owner, repo, path: pathParts } = await params;

    // 1. 优先从进程内 TTL 缓存获取仓库元数据（未命中再查 DB）
    const cachedRepo = await cachedDefaultBranchRepository(owner, repo);
    const repository = cachedRepo || await prisma.repository.findFirst({
      where: {
        owner,
        repo,
      },
      select: {
        id: true,
        isPublic: true,
        branch: true,
        gitSha: true,
      },
    });

    if (!repository) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    // 2. 鉴权与限流：公开仓走快速通道（Fast-Path），彻底跳过 getSessionHelper()
    if (repository.isPublic) {
      if (
        !(await checkRateLimit(
          `assets:ip:${clientIpFromRequest(req.headers)}`,
          ENGINE_CONFIG.rateLimit.publicReadAssetsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadAssetsWindowMs
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }
    } else {
      // 私有仓：惰性求值 session 鉴权
      const session = await getSessionHelper();
      const userId = session?.user?.id;

      if (
        !(await checkRateLimit(
          `assets:${userId ? `user:${userId}` : `ip:${clientIpFromRequest(req.headers)}`}`,
          ENGINE_CONFIG.rateLimit.publicReadAssetsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadAssetsWindowMs
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }

      const isAuthorized = await verifyRepoAccessDirect(repository, userId);
      if (!isAuthorized) {
        return NextResponse.json({ error: 'Forbidden: You do not have access to this asset' }, { status: 403 });
      }
    }

  // 3. Resolve file from safe storage
  const relativeFilePath = pathParts.join('/');

  // 纵深防御：历史 bug 产生的自嵌套污染路径（api/assets/... 对上游恒 404），
  // 提前拒绝，避免无谓打到 GitHub raw 浪费配额
  if (relativeFilePath === 'api/assets' || relativeFilePath.startsWith('api/assets/')) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const secureStorageDir = getRepoAssetsDir(owner, repo);
  const resolvedFilePath = path.normalize(path.join(secureStorageDir, relativeFilePath));

   // Security check: prevent path traversal attacks
   const relativeToStorage = path.relative(secureStorageDir, resolvedFilePath);
   if (relativeToStorage.startsWith('..') || path.isAbsolute(relativeToStorage)) {
     return NextResponse.json({ error: 'Forbidden: Invalid path' }, { status: 403 });
   }

  // 3.1 优先下沉 Go worker-sidecar 原生流式直出（零拷贝 + Range 206 + 304 协商缓存）
  const sidecarRes = await executeSidecarAssetServe({
    owner,
    repo,
    path: relativeFilePath,
    sha: repository.gitSha,
    branch: repository.branch,
    headers: req.headers,
    method: req.method,
  });

  if (sidecarRes) {
    if (sidecarRes.status === 404) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }
    const extraHeaders = !repository.isPublic ? { 'cache-control': 'private, no-cache' } : undefined;
    return pipeSidecarAssetResponse(sidecarRes, extraHeaders);
  }

  const assetCacheControl = repository.isPublic ? CACHE_CONTROL_STRATEGIES.immutableAssets : 'private, no-cache';

  const respondAsset = (fileBuffer: Buffer, contentType: string) =>
    new Response(new Uint8Array(fileBuffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': assetCacheControl,
        'X-Content-Type-Options': 'nosniff',
      }
    });

  // 非本地驱动：对象存储优先（s3/CDN 源）；未命中继续走本地归档/远端回源
  if (activeStorageDriverName() !== 'local') {
    const objectKey = assetObjectKey(owner, repo, relativeFilePath);
    // CDN 直出：配置公网基址且对象存在 → 302 卸载 Next 流量（浏览器缓存 immutable）
    if (ENGINE_CONFIG.storage.publicBaseUrl) {
      const stored = await getAsset(owner, repo, relativeFilePath);
      if (stored) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${ENGINE_CONFIG.storage.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`,
            'Cache-Control': assetCacheControl,
          },
        });
      }
    } else {
      const stored = await getAsset(owner, repo, relativeFilePath);
      if (stored) {
        return respondAsset(stored, mime.lookup(resolvedFilePath) || 'application/octet-stream');
      }
    }
  }

  // Dynamic Fallback: If asset does not exist in local disk cache, fetch from GitHub & cache locally
  if (!(await fs.pathExists(resolvedFilePath))) {
    // 本地优先：归档命中时直接从归档复制（0 网络、不消耗 GitHub 配额）
    const archiveSha = repository.gitSha && /^[0-9a-f]{7,40}$/i.test(repository.gitSha) ? repository.gitSha : null;
    if (archiveSha) {
      const archiveRes = await tryServeFromLocalArchive({
        owner,
        repo,
        archiveSha,
        relativeFilePath,
        secureStorageDir,
        resolvedFilePath,
        respondAsset,
      });
      if (archiveRes) {
        return archiveRes;
      }
    }

    // ref 优先导入冻结 sha（快照一致性——与 transformer 资产回源同款纪律），缺失回落 branch
    const rawRef = archiveSha || repository.branch || ENGINE_CONFIG.defaultBranch;
    const remoteUrl = `${GITHUB_ENDPOINTS.raw}/${owner}/${repo}/${rawRef}/${relativeFilePath}`;

    try {
      // 经统一咽喉（raw 回源：平台池轮询+冷却+配额埋点；原裸 fetch 只认 env 单 token）
      const ghRes = await githubFetch(remoteUrl, {}, { endpointClass: 'raw' });
     if (ghRes.ok) {
       const arrayBuffer = await ghRes.arrayBuffer();
       const buffer = Buffer.from(arrayBuffer);

        // Auto-cache（经存储驱动：local 落盘 / s3 入桶）
       await putAsset(owner, repo, relativeFilePath, buffer);

       const contentType = mime.lookup(resolvedFilePath) || ghRes.headers.get('content-type') || 'application/octet-stream';
       return respondAsset(buffer, contentType);
     }
   } catch (fetchErr) {
     console.warn(`[Asset Cache Fallback] Failed to fetch remote asset from ${remoteUrl}:`, fetchErr);
   }

   return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
 }

 // Ensure resolved path is a file, not a directory
 const stat = await fs.stat(resolvedFilePath);
 if (!stat.isFile()) {
   return NextResponse.json({ error: 'Forbidden: Path is a directory' }, { status: 403 });
 }

 // 4. Read file and send with correct MIME type
 const fileBuffer = await fs.readFile(resolvedFilePath);
 const contentType = mime.lookup(resolvedFilePath) || 'application/octet-stream';

 return respondAsset(fileBuffer, contentType);
 } catch (error: any) {
 console.error('[GET /api/assets/...]', error);
 return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
 }
}

export const HEAD = GET;

async function tryServeFromLocalArchive(params: {
  owner: string;
  repo: string;
  archiveSha: string;
  relativeFilePath: string;
  secureStorageDir: string;
  resolvedFilePath: string;
  respondAsset: (fileBuffer: Buffer, contentType: string) => Response;
}): Promise<Response | null> {
  try {
    const { copyFileLocal } = await import('@/engine/repo-tarball');
    const copied = await copyFileLocal(
      params.owner,
      params.repo,
      params.archiveSha,
      params.relativeFilePath,
      params.secureStorageDir
    );
    if (!copied) return null;

    const stat = await fs.stat(params.resolvedFilePath);
    if (!stat.isFile()) return null;

    const fileBuffer = await fs.readFile(params.resolvedFilePath);
    if (activeStorageDriverName() !== 'local') {
      await putAsset(params.owner, params.repo, params.relativeFilePath, fileBuffer).catch((mirrorErr) => {
        console.warn(`[Asset Cache] mirror to object storage failed for ${params.relativeFilePath}:`, mirrorErr);
      });
    }
    const contentType = mime.lookup(params.resolvedFilePath) || 'application/octet-stream';
    return params.respondAsset(fileBuffer, contentType);
  } catch (copyErr) {
    console.warn(`[Asset Cache] Archive copy failed for ${params.relativeFilePath}, falling back to raw fetch:`, copyErr);
    return null;
  }
}
