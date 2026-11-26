import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute } from '@/lib/api/server/define-route';
import { assertFound } from '@/lib/api/server/api-guards';
import * as m from '@/paraglide/messages';

export const GET = defineRoute({
  scope: 'GET /api/account/export',
  auth: 'user',
  handler: async ({ userId }) => {
    const [user, importRecords, savedRepos, tokens, readingProgress, events, conversations, votes] =
      await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, email: true, image: true, tier: true, createdAt: true,
            preferredLang1: true, preferredLang2: true, preferredLang3: true, industry: true, primaryProgLang: true, fontSize: true },
        }),
        prisma.importRecord.findMany({ where: { userId }, select: { owner: true, repo: true, branch: true, sha: true, createdAt: true } }),
        prisma.repository.findMany({ where: { savedRepos: { some: { userId } } }, select: { id: true, owner: true, repo: true, branch: true } }),
        prisma.mcpApiToken.findMany({ where: { userId }, select: { name: true, prefix: true, lastUsedAt: true, createdAt: true, revokedAt: true } }),
        prisma.userReadingProgress.findMany({ where: { userId }, select: { repositoryId: true, lastReadPath: true, completedPaths: true, updatedAt: true } }),
        prisma.episodicEvent.findMany({ where: { userId }, select: { eventType: true, pageUrl: true, createdAt: true }, take: ENGINE_CONFIG.pagination.adminTelemetry, orderBy: { createdAt: 'desc' } }),
        prisma.conversation.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true } }),
        prisma.helpfulVote.findMany({ where: { userId }, select: { repositoryId: true, createdAt: true } }),
      ]);

    assertFound(user);

    const payload = {
      exportedAt: new Date().toISOString(),
      notice: m.account_export_desc(),
      user,
      importRecords,
      savedRepositories: savedRepos,
      mcpTokens: tokens,
      readingProgress,
      telemetryEvents: events,
      conversations,
      helpfulVotes: votes,
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="opengits-data-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  },
});
