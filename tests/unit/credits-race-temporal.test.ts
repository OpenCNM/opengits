import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 积分账本并发竞态单测（Node 编排层）。
 *
 * 物理事实分工（346·零物化与单写账本）：
 * - SQL 原子性（FOR UPDATE 行锁 + "creditBalance >= $1" 条件扣减 + advisory
 *   lock 查重）在 Go internal/credits，其文本已由 cas_anchor_test.go 锚定；
 * - 本文件用状态化 callSidecar mock **按上述 SQL 语义**实现临界区，验证
 *   Node 编排（shelf-fee.ts / import-reward.ts）在高并发交错下不引入
 *   额外竞态窗口：不透支、不重复落账、幂等短路正确。
 */

const savedRepoFindUniqueMock = vi.fn();
const repositoryFindUniqueMock = vi.fn();
const importRecordFindFirstMock = vi.fn();
const chapterUpdateJobFindFirstMock = vi.fn();
const chapterVersionFindFirstMock = vi.fn();
const creditGrantLedgerFindFirstMock = vi.fn();
const pendingCreditGrantFindFirstMock = vi.fn();
const importJobFindManyMock = vi.fn();
const documentFindManyMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    savedRepo: { findUnique: (...a: unknown[]) => savedRepoFindUniqueMock(...a) },
    repository: { findUnique: (...a: unknown[]) => repositoryFindUniqueMock(...a) },
    importRecord: { findFirst: (...a: unknown[]) => importRecordFindFirstMock(...a) },
    chapterUpdateJob: { findFirst: (...a: unknown[]) => chapterUpdateJobFindFirstMock(...a) },
    chapterVersion: { findFirst: (...a: unknown[]) => chapterVersionFindFirstMock(...a) },
    creditGrantLedger: { findFirst: (...a: unknown[]) => creditGrantLedgerFindFirstMock(...a) },
    pendingCreditGrant: { findFirst: (...a: unknown[]) => pendingCreditGrantFindFirstMock(...a) },
    importJob: { findMany: (...a: unknown[]) => importJobFindManyMock(...a) },
    document: { findMany: (...a: unknown[]) => documentFindManyMock(...a) },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...a: unknown[]) => callSidecarMock(...a),
}));

vi.mock('@/lib/credits-config', () => ({
  CREDITS_CONFIG: {},
  getDynamicCreditsConfig: vi.fn().mockResolvedValue({ shelfFeeMultiplier: 1 }),
}));

vi.mock('@/lib/credits/import-billing', () => ({
  settleImportBilling: vi.fn(() => ({ rewardCredits: 500 })),
}));

import { chargeShelfFeeAndSave } from '@/lib/credits/shelf-fee';
import { getPublicationContent, grantImportReward } from '@/lib/credits/import-reward';
import { prisma } from '@/lib/db';

interface ChargeSidecarState {
  balance: number;
  savedRepos: Set<string>;
  freeSaved: Set<string>;
  paidRows: Array<{ userId: string; repositoryId: string; paidCredits: number }>;
}

/** 镜像 Go ChargeShelfFeeAndSave 的临界区语义（事务内查重 + 条件扣减，同步段=行锁串行） */
function installChargeStatefulMock(state: ChargeSidecarState) {
  callSidecarMock.mockImplementation(async (path: string, body: {
    userId: string; repositoryId: string; fee: number; autoFollow?: boolean;
  }) => {
    if (path !== '/v1/credits/shelf-fee/charge') return { ok: true };
    await Promise.resolve(); // 事务锁等待的交错窗口
    const key = `${body.userId}|${body.repositoryId}`;
    if (body.fee <= 0) {
      const had = state.freeSaved.has(key);
      state.freeSaved.add(key);
      return { ok: true, fee: 0, signupGift: 0, alreadySaved: had };
    }
    if (state.savedRepos.has(key)) {
      return { ok: true, fee: 0, signupGift: 0, alreadySaved: true };
    }
    if (state.balance < body.fee) {
      return { ok: false, code: 'INSUFFICIENT_BALANCE', fee: body.fee, balance: state.balance };
    }
    state.balance -= body.fee;
    state.savedRepos.add(key);
    state.paidRows.push({ userId: body.userId, repositoryId: body.repositoryId, paidCredits: body.fee });
    return { ok: true, fee: body.fee, balance: state.balance, signupGift: 0, alreadySaved: false };
  });
}

function freshChargeState(balance: number): ChargeSidecarState {
  return { balance, savedRepos: new Set(), freeSaved: new Set(), paidRows: [] };
}

/** 默认付费仓：账本 80 × 系数 1 → 费用 80；无豁免记录 */
function seedPaidRepoFixture() {
  savedRepoFindUniqueMock.mockImplementation(async ({ where }: { where: { userId: string; repositoryId: string } }) =>
    null,
  );
  repositoryFindUniqueMock.mockResolvedValue({
    isPublic: true, transcriptionCreditsEarned: 80, _count: { documents: 0 },
  });
  importRecordFindFirstMock.mockResolvedValue(null);
  chapterUpdateJobFindFirstMock.mockResolvedValue(null);
  chapterVersionFindFirstMock.mockResolvedValue(null);
}

describe('书架扣费高并发超卖对抗（chargeShelfFeeAndSave × Promise.all）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedPaidRepoFixture();
  });

  it('余额 100 / 单价 80 / 10 路并发：恰 1 次扣费成功，余额绝不为负，实付流水恰 1 行', async () => {
    const state = freshChargeState(100);
    installChargeStatefulMock(state);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => chargeShelfFeeAndSave('u-race', 'repo-race')),
    );

    // 全部请求有明确结局（无静默失败/悬挂）
    for (const r of results) expect(r.ok).toBe(true);
    // 恰 1 次真实扣费（fee=80、非幂等命中）
    const paid = results.filter((r) => r.ok && r.fee === 80 && !r.alreadySaved);
    expect(paid).toHaveLength(1);
    expect(paid[0].balance).toBe(20);
    // 其余 9 路全部被事务内存在性查重幂等吸收（alreadySaved）
    expect(results.filter((r) => r.ok && r.alreadySaved)).toHaveLength(9);
    // 账本守恒：终态余额 100-80=20；全程无负余额读数；实付行恰 1 条
    expect(state.balance).toBe(20);
    expect(state.paidRows).toHaveLength(1);
    expect(state.paidRows[0]).toEqual({ userId: 'u-race', repositoryId: 'repo-race', paidCredits: 80 });
    for (const r of results) {
      if (typeof r.balance === 'number') expect(r.balance).toBeGreaterThanOrEqual(0);
    }
  });

  it('余额 50 / 单价 80：单次与并发均 Fail-Closed 阻断（INSUFFICIENT_BALANCE），零实付', async () => {
    const state = freshChargeState(50);
    installChargeStatefulMock(state);

    const single = await chargeShelfFeeAndSave('u-poor', 'repo-poor');
    expect(single).toMatchObject({ ok: false, code: 'INSUFFICIENT_BALANCE', fee: 80, balance: 50 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => chargeShelfFeeAndSave('u-poor2', 'repo-poor')),
    );
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, code: 'INSUFFICIENT_BALANCE' });
    }
    expect(state.balance).toBe(50);
    expect(state.paidRows).toHaveLength(0);
  });

  it('零费路径（豁免用户）并发重复收藏：ON CONFLICT DO NOTHING → 恰 1 次插入，全部幂等成功', async () => {
    const state = freshChargeState(0);
    installChargeStatefulMock(state);
    importRecordFindFirstMock.mockResolvedValue({ id: 'ir-1' }); // 导入者豁免 → fee 0

    const results = await Promise.all(
      Array.from({ length: 5 }, () => chargeShelfFeeAndSave('u-free', 'repo-free')),
    );
    for (const r of results) {
      expect(r).toMatchObject({ ok: true, fee: 0, signupGift: 0 });
    }
    expect(results.filter((r) => !r.alreadySaved)).toHaveLength(1);
    expect(state.freeSaved.size).toBe(1);
    expect(state.paidRows).toHaveLength(0);
  });
});

describe('导入奖励发放防重放（grantImportReward 前置双查 + sidecar 去重契约）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    documentFindManyMock.mockImplementation(async (args: { select: Record<string, unknown> }) => {
      // Phase 1 薄行（仅 path）与 Phase 2 内容批查分别供给
      if (args.select && args.select.path === true && args.select.content === undefined) {
        return [{ path: 'guide/a.md' }];
      }
      return [{ path: 'guide/a.md', ownerUserId: null, status: 'PROCESSED', content: 'AAA', contentRef: null }];
    });
    importRecordFindFirstMock.mockResolvedValue(null);
    chapterUpdateJobFindFirstMock.mockResolvedValue(null);
    chapterVersionFindFirstMock.mockResolvedValue(null);
    creditGrantLedgerFindFirstMock.mockResolvedValue(null);
    pendingCreditGrantFindFirstMock.mockResolvedValue(null);
  });

  /** 以真实实现为自身预言机构造发布快照（contentHash 门禁逐字节一致） */
  async function seedGrantableRepo(repositoryId: string, userId: string) {
    const content = await getPublicationContent(
      prisma as unknown as Parameters<typeof getPublicationContent>[0],
      repositoryId,
      userId,
    );
    expect(content.ready).toBe(true);
    repositoryFindUniqueMock.mockResolvedValue({
      isPublic: true,
      reviewStatus: 'APPROVED',
      publishedAt: new Date(),
      owner: 'o', repo: 'r', branch: 'main', edition: '',
      reviewPipeline: { publication: { userId, contentHash: content.contentHash } },
    });
    importJobFindManyMock.mockResolvedValue([
      { params: { kind: 'github', publishRequested: true, options: {} }, result: { repositoryId } },
    ]);
    return content;
  }

  it('前置双查短路：台账已有 IMPORT_REWARD → 返回 0 且零 sidecar 调用', async () => {
    await seedGrantableRepo('repo-dup', 'u-grant');
    creditGrantLedgerFindFirstMock.mockResolvedValue({ id: 'ledger-exists' });

    const granted = await grantImportReward('repo-dup');
    expect(granted).toBe(0);
    const grantCalls = callSidecarMock.mock.calls.filter((c) => c[0] === '/v1/credits/import-reward/grant');
    expect(grantCalls).toHaveLength(0);
  });

  it('前置双查短路（第二源）：PendingCreditGrant 未解冻记录同样拦截', async () => {
    await seedGrantableRepo('repo-dup-p', 'u-grant');
    pendingCreditGrantFindFirstMock.mockResolvedValue({ id: 'pending-exists' });

    expect(await grantImportReward('repo-dup-p')).toBe(0);
    expect(callSidecarMock.mock.calls.filter((c) => c[0] === '/v1/credits/import-reward/grant')).toHaveLength(0);
  });

  it('并发双发（前置双查 TOCTOU 交错）→ sidecar 咨询锁契约去重：恰 1 次入账，输家 ALREADY_GRANTED', async () => {
    await seedGrantableRepo('repo-race', 'u-grant');
    // 镜像 Go GrantImportReward：advisory lock（同步临界区）+ 双存在性检查；
    // await 窗口制造两路都通过 Node 前置查重的交错
    const grantedRepos = new Set<string>();
    let ledgerInserts = 0;
    callSidecarMock.mockImplementation(async (path: string, body: { repositoryId: string; amount: number }) => {
      if (path !== '/v1/credits/import-reward/grant') return { ok: true };
      await Promise.resolve();
      await Promise.resolve();
      if (grantedRepos.has(body.repositoryId)) {
        return { granted: false, amount: 0, reason: 'ALREADY_GRANTED' };
      }
      grantedRepos.add(body.repositoryId);
      ledgerInserts += 1;
      return { granted: true, amount: body.amount };
    });

    const [a, b] = await Promise.all([
      grantImportReward('repo-race'),
      grantImportReward('repo-race'),
    ]);
    // 恰一路实发 500，另一路幂等归零；台账物理插入恰 1 条
    expect(a + b).toBe(500);
    expect(Math.max(a, b)).toBe(500);
    expect(Math.min(a, b)).toBe(0);
    expect(ledgerInserts).toBe(1);
    const grantCalls = callSidecarMock.mock.calls.filter((c) => c[0] === '/v1/credits/import-reward/grant');
    expect(grantCalls).toHaveLength(2);
  });
});
