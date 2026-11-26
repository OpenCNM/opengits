import { NextResponse } from 'next/server';
import { defineRoute } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { getImportJobSnapshot } from '@/lib/jobs/import-job-store';

export const dynamic = 'force-dynamic';

export const GET = defineRoute<{ id: string }>({
  scope: 'GET /api/ingest-jobs/[id]',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;

    const sinceRaw = request.nextUrl.searchParams.get('since');
    const since = sinceRaw !== null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : -1;

    const snapshot = await getImportJobSnapshot(id, userId, since);
    if (!snapshot) {
      throw ApiError.notFound('Job not found');
    }

    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'no-store' },
    });
  },
});
