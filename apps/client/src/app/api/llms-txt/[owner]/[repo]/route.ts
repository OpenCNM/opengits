import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG, CACHE_CONTROL_STRATEGIES } from '@/lib/config';
import { resolveRepository } from '@/lib/repository-resolver';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { executeSidecarLlmsTxt } from '@/engine/llms-txt-driver';
import { getCorsHeaders } from '@/lib/constants';
import { checkRateLimit, clientIpFromRequest } from '@/lib/rate-limit';

export async function GET(
 request: Request,
 { params }: { params: Promise<{ owner: string; repo: string }> }
) {
 try {
 const { owner, repo } = await params;

 const session = await getSessionHelper();
 const userId = session?.user?.id;

 // 限流兜底失控脚本：登录按 userId（共 IP 不连坐），匿名按 IP（阈值按 NAT 聚合放宽，见 config）
 if (
 !(await checkRateLimit(
 `llms-txt:${userId ? `user:${userId}` : `ip:${clientIpFromRequest(request.headers)}`}`,
 ENGINE_CONFIG.rateLimit.publicReadDocsMaxRequests,
 ENGINE_CONFIG.rateLimit.publicReadDocsWindowMs
 ))
 ) {
 return new NextResponse('Too Many Requests', { status: 429, headers: corsHeaders() });
 }

 const url = new URL(request.url);
 const versionOrBranch = url.searchParams.get('version') || url.searchParams.get('branch') || request.headers.get('x-target-version') || undefined;

 const resolved = await resolveRepository(owner, repo, versionOrBranch);
 if (!resolved || !resolved.repository) {
 return new NextResponse('Repository not found', { status: 404, headers: corsHeaders() });
 }

 const repository = resolved.repository;
 const targetVersion = versionOrBranch || resolved.targetVersionLabel || resolved.resolvedBranch;

 const isAuthorized = await verifyRepoAccessDirect(repository, userId);
 if (!repository.isPublic && !isAuthorized) {
 return new NextResponse('Forbidden: Repository is private', { status: 403, headers: corsHeaders() });
 }

 const full = url.searchParams.get('full') === 'true';
 const baseUrl = `${url.protocol}//${url.host}`;
 const budgetParam = url.searchParams.get('budget');
 const budget = budgetParam && !isNaN(parseInt(budgetParam, 10)) ? parseInt(budgetParam, 10) : undefined;
 const topic = url.searchParams.get('topic') || undefined;
 const modeParam = url.searchParams.get('mode');
 const mode = modeParam === 'strict' || modeParam === 'balanced' ? modeParam : undefined;

  // 优先通过 Go worker-sidecar 生成 llms.txt（直读 DB，零 Node.js V8 堆内存搬运与 GC 停顿）
  let sidecarResult = await executeSidecarLlmsTxt({
    repositoryId: repository.id,
    owner,
    repo,
    version: targetVersion,
    baseUrl,
    full,
    budget,
    topic,
    mode,
    userId,
  });

  // Go worker-sidecar 单实现（Fail-Closed，2026-09-11 收刀）：本地 TS 生成器已物理
  // 删除（Go pgx store 同位自查 repository/documents/navTree），故障显式 502
  const content: string | null = sidecarResult?.content ?? null;
  const estimatedTokens = sidecarResult?.estimatedTokens ?? 0;
  const downgradedCount = sidecarResult?.downgradedCount ?? 0;
  const finalVersion = sidecarResult?.targetVersion || targetVersion;

  if (!content) {
    return new NextResponse('Failed to generate llms.txt', { status: 500, headers: corsHeaders() });
  }

  return new NextResponse(content, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': CACHE_CONTROL_STRATEGIES.dynamicDocs,
      'X-Estimated-Tokens': String(estimatedTokens),
      'X-Downgraded-Count': String(downgradedCount),
      'X-Target-Version': finalVersion || ENGINE_CONFIG.defaultBranch,
    },
  });
 } catch (error) {
 console.error('Error generating llms.txt:', error);
 return new NextResponse('Internal Server Error', { status: 500, headers: corsHeaders() });
 }
}

function corsHeaders() {
 return getCorsHeaders('GET, OPTIONS');
}

export async function OPTIONS() {
 return new NextResponse(null, {
 status: 204,
 headers: corsHeaders()
 });
}
