/**
 * apps/client/src/engine/credits-driver.ts
 *
 * 积分经济与底账流转驱动（向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/credits/*），在 Go 进程内直接通过 pgxpool
 *    完成跨表多源聚合、行级锁（SELECT FOR UPDATE）扣减、开户礼金 CAS 与发奖事务；
 * 2. Fail-Closed 单实现：消除 Node 端对 CreditGrantLedger 的 Prisma 双写，双写面收窄；
 * 3. 严格遵循契约：输入输出契约与既有前端页面/接口完全保形。
 */

import { callSidecar } from '@/lib/sidecar-client';

interface SidecarLedgerEntry {
  id: string;
  amount: number;
  source: string;
  repositoryId: string | null;
  detail: string | null;
  at: string;
  repoLabel?: string | null;
}

interface SidecarCreditsLedgerResult {
  entries: SidecarLedgerEntry[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  balance: number;
  savedRepos: number;
}

type SidecarShelfFeeChargeResult =
  | { ok: true; fee: number; signupGift: number; alreadySaved: boolean; balance?: number }
  | { ok: false; code: 'INSUFFICIENT_BALANCE'; fee: number; balance: number };

interface SidecarImportRewardGrantResult {
  granted: boolean;
  amount: number;
  immediateAmount?: number;
  pendingAmount?: number;
  vestingDays?: number;
  reason?: string;
}

/**
 * 查询用户多源聚合积分流水（由 Go worker-sidecar 原生聚合与分页）。
 */
export async function executeSidecarCreditsLedger(
  userId: string,
  page: number,
  pageSize: number
): Promise<SidecarCreditsLedgerResult> {
  return callSidecar<SidecarCreditsLedgerResult>(
    '/v1/credits/ledger',
    { userId, page, pageSize },
    { label: 'credits /v1/credits/ledger', timeoutMs: 10_000 }
  );
}

/**
 * 扣减书架费并加入收藏（行级排他锁与原子扣费）。
 */
export async function executeSidecarShelfFeeCharge(
  userId: string,
  repositoryId: string,
  fee: number,
  autoFollow = true
): Promise<SidecarShelfFeeChargeResult> {
  return callSidecar<SidecarShelfFeeChargeResult>(
    '/v1/credits/shelf-fee/charge',
    { userId, repositoryId, fee, autoFollow },
    { label: 'credits /v1/credits/shelf-fee/charge', timeoutMs: 10_000 }
  );
}

/**
 * 发放导入奖励（咨询锁查重、入账、记录台账与发送通知）。
 */
export async function executeSidecarImportRewardGrant(params: {
  repositoryId: string;
  userId: string;
  amount: number;
  owner: string;
  repo: string;
}): Promise<SidecarImportRewardGrantResult> {
  return callSidecar<SidecarImportRewardGrantResult>(
    '/v1/credits/import-reward/grant',
    params,
    { label: 'credits /v1/credits/import-reward/grant', timeoutMs: 10_000 }
  );
}

