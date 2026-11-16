import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { captureError } from '@/lib/observability/errors';

// GET /api/mcp/hub/bundles - Public endpoint returning admin-curated skill bundles
export async function GET() {
  try {
    const bundles = await prisma.mcpBundle.findMany({
      where: {
        isPinned: true,
      },
      include: {
        repositories: {
          // 与 bundle 详情端点同口径：仅公开且未暂停的仓进合集公开列表
          // （防私有仓/PAUSED 仓元数据经公开端点外泄）
          where: { isPublic: true, mcpStatus: { not: 'PAUSED' } },
          select: {
            id: true,
            owner: true,
            repo: true,
            category: true,
            isVerified: true,
            starCount: true,
            mcpCallCount: true,
          },
        },
      },
      orderBy: [
        { displayOrder: 'asc' },
        { createdAt: 'desc' },
      ],
    });

    const formattedBundles = bundles.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.title,
      badge: b.badge || '❖ 官方精选',
      description: b.description || `包含 ${b.repositories.length} 本精选智能典籍`,
      repos: b.repositories.map((r) => ({
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        title: r.repo,
        category: r.category || 'General',
      })),
    }));

    return NextResponse.json({ success: true, bundles: formattedBundles });
  } catch (error: unknown) {
    // fail-fast：DB 物理故障不得伪装成「无精选合集」的 200 空数据（伪弹性掩盖真实故障）
    await captureError(error, { scope: 'GET /api/mcp/hub/bundles' });
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
