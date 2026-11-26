import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';
import { internalAuthGuard } from '@/lib/internal-auth';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { outlineActiveCacheTag } from '@/lib/outline-reader';
import { PromptRegistry } from '@/lib/prompt-registry';
import { invalidateGatewayPolicyCache } from '@/lib/gateway/policy';
import { syncDefaultCoordinatorLimitsFromPolicy } from '@/lib/llm-gateway/service';

export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const tags = Array.isArray(body.tags) ? body.tags.filter((t: unknown): t is string => typeof t === 'string') : [];
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const repositoryIds = Array.isArray(body.repositoryIds)
    ? body.repositoryIds.filter((r: unknown): r is string => typeof r === 'string')
    : [];
  const promptKeys = Array.isArray(body.promptKeys)
    ? body.promptKeys.filter((k: unknown): k is string => typeof k === 'string')
    : [];

  for (const tag of tags.slice(0, 32)) {
    revalidateTag(tag, 'max');
  }
  for (const p of paths.slice(0, 64)) {
    if (typeof p?.path === 'string') {
      revalidatePath(p.path, p.type === 'layout' ? 'layout' : 'page');
    }
  }
  for (const repoId of repositoryIds.slice(0, 64)) {
    invalidateWebL1Projection(repoId);
    revalidateTag(outlineActiveCacheTag(repoId), 'max');
  }

  for (const key of promptKeys.slice(0, 64)) {
    PromptRegistry.invalidateCache(key);
  }

  let runtimePolicyReloaded = false;
  let runtimeConcurrency: Awaited<ReturnType<typeof syncDefaultCoordinatorLimitsFromPolicy>>['effective'] | undefined;
  if (body.reloadRuntimePolicy === true) {
    invalidateGatewayPolicyCache();
    const runtime = await syncDefaultCoordinatorLimitsFromPolicy();
    runtimePolicyReloaded = true;
    runtimeConcurrency = runtime.effective;
  }

  return NextResponse.json({
    ok: true,
    tags: tags.length,
    paths: paths.length,
    repositoryIds: repositoryIds.length,
    promptKeys: promptKeys.length,
    ...(runtimePolicyReloaded ? { runtimePolicyReloaded, runtimeConcurrency } : {}),
  });
}
