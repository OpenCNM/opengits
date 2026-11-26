import { NextResponse } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { ENGINE_CONFIG, CACHE_CONTROL_STRATEGIES } from '@/lib/config';
import { getCorsHeaders } from '@/lib/constants';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { callSidecar } from '@/lib/sidecar-client';

interface SidecarDocContentResponse {
  ok: boolean;
  document?: {
    id: string;
    path: string;
    title: string;
    status: string;
    content: string;
  };
  error?: string;
  code?: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; slug?: string[] }> }
) {
  try {
    const { owner, repo, slug } = await params;

    const repository = await cachedDefaultBranchRepository(owner, repo);

    if (!repository) {
      return new NextResponse('Repository not found', { status: 404 });
    }

    let userId: string | undefined = undefined;

    if (repository.isPublic) {
      if (
        !(await checkRateLimit(
          `docs-content:ip:${clientIpFromRequest(request.headers)}`,
          ENGINE_CONFIG.rateLimit.publicReadDocsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadDocsWindowMs
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }
    } else {
      const session = await getSessionHelper();
      userId = session?.user?.id;

      if (
        !(await checkRateLimit(
          `docs-content:${userId ? `user:${userId}` : `ip:${clientIpFromRequest(request.headers)}`}`,
          ENGINE_CONFIG.rateLimit.publicReadDocsMaxRequests,
          ENGINE_CONFIG.rateLimit.publicReadDocsWindowMs
        ))
      ) {
        return new NextResponse('Too Many Requests', { status: 429 });
      }

      const isAuthorized = await verifyRepoAccessDirect(repository, userId);
      if (!isAuthorized) {
        return new NextResponse('Forbidden: Repository is private', { status: 403 });
      }
    }

    if (!slug || slug.length === 0) {
      return new NextResponse('Document path required', { status: 400 });
    }

    const rawJoined = slug.join('/');
    let relativePath = rawJoined;
    if (!rawJoined.endsWith('.md') && !rawJoined.endsWith('.mdx')) {
      relativePath = `${rawJoined}.md`;
    }

    const candidatePaths: string[] = [relativePath];
    if (relativePath.endsWith('.md')) {
      candidatePaths.push(relativePath.slice(0, -3) + '.mdx');
    }
    candidatePaths.push(`${rawJoined}/README.md`);

    const res = await callSidecar<SidecarDocContentResponse>(
      '/v1/documents/content',
      {
        repositoryId: repository.id,
        candidatePaths,
        userId,
      },
      { label: 'docs-content /v1/documents/content', timeoutMs: 5_000 }
    );

    if (!res.ok || !res.document || !res.document.content) {
      return new NextResponse('Document content not found or processing', {
        status: 404,
        headers: corsHeaders(),
      });
    }

    return new NextResponse(res.document.content, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': CACHE_CONTROL_STRATEGIES.dynamicDocs,
      },
    });
  } catch (error) {
    console.error('Error fetching document content:', error);
    return new NextResponse('Internal Server Error', { status: 500, headers: corsHeaders() });
  }
}

function corsHeaders() {
  return getCorsHeaders('GET, OPTIONS');
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}
