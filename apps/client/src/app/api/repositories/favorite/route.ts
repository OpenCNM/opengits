import { revalidateTag } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';

const favoriteActionSchema = z.object({
  repositoryId: z.string().min(1),
  action: z.enum(['favorite', 'unfavorite', 'toggle']).default('toggle'),
});

export const POST = defineRoute({
  scope: 'POST /api/repositories/favorite',
  auth: 'user',
  bodySchema: favoriteActionSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const { repositoryId, action } = body;

    const targetRepo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { id: true },
    });
    if (!targetRepo) {
      throw ApiError.notFound('Repository not found');
    }

    let isFavorited: boolean;
    if (action === 'favorite') {
      await prisma.favoriteRepo.upsert({
        where: { userId_repositoryId: { userId, repositoryId } },
        create: { userId, repositoryId },
        update: {},
      });
      isFavorited = true;
    } else if (action === 'unfavorite') {
      await prisma.favoriteRepo.deleteMany({
        where: { userId, repositoryId },
      });
      isFavorited = false;
    } else {
      const existing = await prisma.favoriteRepo.findUnique({
        where: { userId_repositoryId: { userId, repositoryId } },
        select: { id: true },
      });
      if (existing) {
        await prisma.favoriteRepo.deleteMany({
          where: { userId, repositoryId },
        });
        isFavorited = false;
      } else {
        await prisma.favoriteRepo.upsert({
          where: { userId_repositoryId: { userId, repositoryId } },
          create: { userId, repositoryId },
          update: {},
        });
        isFavorited = true;
      }
    }

    const favoriteCount = await prisma.favoriteRepo.count({
      where: { repositoryId },
    });

    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');

    return ok({
      isFavorited,
      favoriteCount,
    });
  },
});
