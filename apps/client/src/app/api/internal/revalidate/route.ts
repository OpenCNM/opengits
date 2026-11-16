import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';
import { internalAuthGuard } from '@/lib/internal-auth';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { outlineActiveCacheTag } from '@/lib/outline-reader';
import { PromptRegistry } from '@/lib/prompt-registry';

/**
 * 内部缓存失效端点（Phase 1 补丁）：供 admin 应用跨进程失效 client 的
 * 数据缓存（unstable_cache 的 tag 存活在各自进程内——admin 里调
 * revalidateTag 只能清自己的存储，摸不到 client 进程的 'home:v1'）。
 *
 * 鉴权见 lib/internal-auth（单一事实源，LLM 网关等内部端点共用）。
 *
 * body: { tags?: string[]; paths?: Array<{ path: string; type?: 'page'|'layout' }>; repositoryIds?: string[] }
 */
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
    // L2 unstable_cache（getActiveOutline）同步清退：仅清 L1 会让重建从 L2
    // 读回旧大纲重新污染 L1，把失效窗口叠加到 ~120s
    revalidateTag(outlineActiveCacheTag(repoId), 'max');
  }

  // prompt 热编辑跨进程即时生效：清退 client 进程的 PromptRegistry 内存缓存
  //（否则最长 10 分钟 TTL 才自然过期；admin 进程内已在 savePromptVersion 即时刷新）
  for (const key of promptKeys.slice(0, 64)) {
    PromptRegistry.invalidateCache(key);
  }

  return NextResponse.json({
    ok: true,
    tags: tags.length,
    paths: paths.length,
    repositoryIds: repositoryIds.length,
    promptKeys: promptKeys.length,
  });
}
