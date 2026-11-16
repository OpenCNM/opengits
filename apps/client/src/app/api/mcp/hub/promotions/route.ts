import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { captureError } from '@/lib/observability/errors';

// GET /api/mcp/hub/promotions - Public endpoint returning active platform promotions
export async function GET() {
  try {
    const now = new Date();
    const promotions = await prisma.platformPromotion.findMany({
      where: {
        isPinned: true,
        AND: [
          {
            OR: [
              { startsAt: null },
              { startsAt: { lte: now } },
            ],
          },
          {
            OR: [
              { endsAt: null },
              { endsAt: { gte: now } },
            ],
          },
        ],
      },
      orderBy: [
        { displayOrder: 'asc' },
        { createdAt: 'desc' },
      ],
    });

    return NextResponse.json({ success: true, promotions });
  } catch (error: unknown) {
    // fail-fast：DB 物理故障不得伪装成「无运营位」的 200 空数据（伪弹性掩盖真实故障）
    await captureError(error, { scope: 'GET /api/mcp/hub/promotions' });
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
