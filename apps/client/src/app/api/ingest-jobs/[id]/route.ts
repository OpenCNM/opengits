import { NextResponse } from 'next/server';
import { defineRoute } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { getImportJobSnapshot } from '@/lib/jobs/import-job-store';

export const dynamic = 'force-dynamic';

/**
 * Job 快照 + 增量事件（轮询兜底通道；SSE 通道见同目录 events/route.ts）。
 * GET /api/ingest-jobs/[id]?since=<seq> → { job, events }（events 仅含 seq 大于 since 的）。
 *
 * 契约说明：消费方（ImportWizardContext.tsx / import-job-subscription.ts）直接读取
 * 裸 snapshot 结构（snapshot.job / snapshot.events），故成功响应保持旧形状、
 * 走 NextResponse 透传逃生舱不套信封；鉴权与错误分支由 defineRoute 统一收口。
 */
export const GET = defineRoute<{ id: string }>({
  scope: 'GET /api/ingest-jobs/[id]',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;

    const sinceRaw = request.nextUrl.searchParams.get('since');
    const since = sinceRaw !== null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : -1;

    const snapshot = await getImportJobSnapshot(id, userId, since);
    if (!snapshot) {
      throw ApiError.notFound('Job not found');
    }

    // 旧形状透传（非信封）：消费方契约依赖
    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'no-store' },
    });
  },
});
