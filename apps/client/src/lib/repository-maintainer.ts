import { prisma } from './db';

/**
 * 教程维护者解析（单一事实源）：
 * 维护者 = 该仓库最早 ImportRecord 的用户（发布/首导者）。
 *
 * 消费方：
 * - lib/scheduler/auto-update.ts —— 自动同步的授权与 BYOK 模型来源
 * - api/repos/[owner]/[repo]/auto-sync —— 维护者开关的权限校验
 * - docs 页 —— 维护者开关的可见性判定
 *
 * 无任何导入记录（理论不可达：建仓必伴随导入）返回 null，调用方按"无维护者"处理。
 */
export async function resolveMaintainerUserId(repositoryId: string): Promise<string | null> {
  const earliest = await prisma.importRecord.findFirst({
    where: { repositoryId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return earliest?.userId ?? null;
}
