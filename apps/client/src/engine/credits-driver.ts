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
