import { prisma } from './db';

export async function resolveMaintainerUserId(repositoryId: string): Promise<string | null> {
  const earliest = await prisma.importRecord.findFirst({
    where: { repositoryId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return earliest?.userId ?? null;
}
