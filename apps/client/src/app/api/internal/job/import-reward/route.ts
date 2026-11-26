import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalAuthGuard } from '@/lib/internal-auth';
import { completeImportRewardCallback } from '@/lib/jobs/import-job-reward';

const bodySchema = z.object({ jobId: z.string().min(1) }).strict();

export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });
  try {
    const result = await completeImportRewardCallback(body.data.jobId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('[import-reward] completion callback failed', error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
