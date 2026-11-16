import { z } from 'zod';

/**
 * 积分发放契约层（三层同步：Prisma ↔ 本 schema ↔ TS 类型）。
 * 章节/JIT 转录发酬已退役；历史台账行的来源标记（JIT_FIRST_TRANSLATE /
 * RETRANSLATE_REWARD / CANONICAL_BONUS 等）由 CreditLedgerView 的
 * SOURCE_LABEL 裸字符串渲染，不经本层常量（2026-11 积分域清理：
 * 零消费的 Zod schema 与 source 常量已拆除，仅存跨语言状态机同步锁
 * 与 unpublish/promote 两个在役路由入参 schema）。
 */

/**
 * 待解冻积分状态机（Vesting Model）。
 *
 * 跨语言分布警示（同步锁见 tests/unit/credit-grant-sync.test.ts）：
 * Node 写入 grant（PENDING），Go vesting_reaper 守护进程按 unlockAt 解冻（→UNLOCKED），
 * unpublish 作废（→CANCELLED），重发布可复活（CANCELLED→PENDING，仅 unlockAt>now）。
 * 任何一侧新增状态值（如争议冻结），另一侧必须显式同步。
 */
export const PENDING_CREDIT_STATUS = {
  PENDING: 'PENDING',
  UNLOCKED: 'UNLOCKED',
  CANCELLED: 'CANCELLED',
} as const;

/**
 * 终态判定：UNLOCKED 为唯一吸收终态（已解冻入账）。
 * CANCELLED 不是终态——重发布且未到期时会被复活回 PENDING
 * （Go credits.sql.go ReactivateCancelledGrants：CANCELLED→PENDING WHERE unlockAt>now）。
 */
export function isTerminalPendingCreditStatus(status: string): boolean {
  return status === PENDING_CREDIT_STATUS.UNLOCKED;
}


export const UnpublishRepositoryInputSchema = z
  .object({
    repoId: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    edition: z.string().optional(),
  })
  .refine((data) => Boolean(data.repoId || (data.owner && data.repo)), {
    message: '必须提供 repoId 或 owner 与 repo',
  });

export type UnpublishRepositoryInput = z.infer<typeof UnpublishRepositoryInputSchema>;

export const PromoteEditionInputSchema = z
  .object({
    repoId: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    edition: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.repoId || (data.owner && data.repo && data.edition)), {
    message: '必须提供 repoId 或 (owner, repo, edition)',
  });

export type PromoteEditionInput = z.infer<typeof PromoteEditionInputSchema>;
