import { z } from 'zod';

export const PENDING_CREDIT_STATUS = {
  PENDING: 'PENDING',
  UNLOCKED: 'UNLOCKED',
  CANCELLED: 'CANCELLED',
} as const;

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
