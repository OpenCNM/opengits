import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { getCorsHeaders } from '@/lib/constants';

function corsHeaders() {
  return getCorsHeaders('GET, OPTIONS');
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo } = await params;

  const repository = await prisma.repository.findFirst({
    where: {
      owner: { equals: owner, mode: 'insensitive' },
      repo: { equals: repo, mode: 'insensitive' },
    },
    select: {
      id: true,
      repoProfile: true,
      isPublic: true,
    },
  });

  if (!repository) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404, headers: corsHeaders() });
  }

  // 访问鉴权：私有仓校验当前登录用户权限
  if (!repository.isPublic) {
    const session = await getSessionHelper();
    const userId = session?.user?.id;
    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Forbidden: Repository is private' }, { status: 403, headers: corsHeaders() });
    }
  }

  const profile = (repository.repoProfile as Record<string, unknown> | null) ?? {};
  const openApiUrl = profile.openApiUrl as string | undefined;

  if (!openApiUrl) {
    return NextResponse.json({ error: 'OpenAPI specification not available' }, { status: 404, headers: corsHeaders() });
  }

  // SSRF 防御校验：仅允许安全的公网 http(s) 终结点，严防私网/回环与危险端口嗅探
  if (!isPublicHttpEndpoint(openApiUrl)) {
    return NextResponse.json(
      { error: 'Forbidden: OpenAPI URL resolves to private or unsafe endpoint' },
      { status: 400, headers: corsHeaders() }
    );
  }

  try {
    const upstreamRes = await fetch(openApiUrl, {
      headers: {
        Accept: 'application/json, application/yaml, text/yaml;q=0.9, */*;q=0.8',
        'User-Agent': 'OpenGits-OpenAPI-Proxy/1.0',
      },
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 3600 },
    });

    if (!upstreamRes.ok) {
      return NextResponse.json(
        { error: `Upstream failed with status ${upstreamRes.status}` },
        { status: 502, headers: corsHeaders() }
      );
    }

    const contentType = upstreamRes.headers.get('content-type') || 'application/json';
    const body = await upstreamRes.text();

    // 内存安全防护：单 spec 上限 15MB
    if (body.length > 15 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'OpenAPI specification exceeds 15MB limit' },
        { status: 502, headers: corsHeaders() }
      );
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': contentType,
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Proxy fetch failed: ${message}` }, { status: 502, headers: corsHeaders() });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}
