import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { assert, assertFound } from '@/lib/api/server/api-guards';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/chapter-versions —— 契约重译本章（产出 PRIVATE 版本，作者可再公开进竞争池）。
 * 同步执行（契约管线跑在作者 BYOK 上）；限流防滥用。
 */
export const POST = defineRoute({
  scope: 'POST /api/chapter-versions',
  auth: 'user',
  rateLimit: {
    limit: 5,
    windowMs: 600_000,
    identifier: ({ userId }) => `retranslate:${userId}`,
  },
  bodySchema: z.object({ documentId: z.string().min(1) }),
  handler: async ({ body, userId }) => {
    const doc = assertFound(
      await prisma.document.findUnique({
        where: { id: body.documentId },
        select: { repository: { select: { id: true, isPublic: true } } },
      })
    );

    assert(await verifyRepoAccessDirect(doc.repository, userId), 'FORBIDDEN');

    const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
    assert(await resolveActiveUserModel(userId), 'NO_MODEL');

    const { retranslateChapter, VersionMarketError } = await import('@/lib/update-market/versions');
    try {
      const { versionId } = await retranslateChapter(body.documentId, userId);
      return ok({ versionId });
    } catch (err) {
      if (err instanceof VersionMarketError) {
        throw ApiError.fromCode(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT', { detail: err.message });
      }
      // L0-R 质量门拒绝是预期业务结果（非未知异常）：保留门禁理由原文
      const message = err instanceof Error ? err.message : '';
      if (message.includes('L0-R')) {
        throw ApiError.fromCode('CONFLICT', { detail: message });
      }
      throw err;
    }
  },
});

/**
 * GET /api/chapter-versions?documentId=... —— 查询指定章节的多版本竞争池与有效状态。
 * 下沉至 Go worker-sidecar 原生聚合（POST /v1/chapter-versions/list）。
 */
export const GET = defineRoute({
  scope: 'GET /api/chapter-versions',
  auth: 'public',
  handler: async ({ request, userId }) => {
    const url = new URL(request.url);
    const documentId = url.searchParams.get('documentId')?.trim();
    if (!documentId) {
      throw ApiError.badRequest('documentId is required');
    }

    const { callSidecar } = await import('@/lib/sidecar-client');
    const res = await callSidecar<{
      ok: boolean;
      versions?: unknown[];
      error?: string;
    }>(
      '/v1/chapter-versions/list',
      { documentId, userId: userId ?? undefined },
      { label: 'chapter-versions /v1/chapter-versions/list', timeoutMs: 5_000 }
    );

    if (!res.ok || !res.versions) {
      throw ApiError.internal(res.error || 'Failed to list chapter versions');
    }

    return ok({ versions: res.versions });
  },
});

