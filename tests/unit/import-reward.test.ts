import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  repository: { findUnique: vi.fn(), update: vi.fn() },
  importJob: { findMany: vi.fn() },
  document: { findMany: vi.fn() },
  creditGrantLedger: { findFirst: vi.fn(), create: vi.fn() },
  pendingCreditGrant: { findFirst: vi.fn(), create: vi.fn() },
  user: { update: vi.fn() },
  notification: { findFirst: vi.fn(), create: vi.fn() },
}));
const mockExecuteSidecarImportRewardGrant = vi.fn();
vi.mock('@/engine/credits-driver', () => ({
  executeSidecarImportRewardGrant: (...args: unknown[]) => mockExecuteSidecarImportRewardGrant(...args),
}));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/credits-config', async (original) => ({
  ...await original<typeof import('@/lib/credits-config')>(),
  getDynamicCreditsConfig: async () => ({ standardChunkCharSize: 1500, maxCreditsPerImport: 300, codePedagogyMultiplier: 2 }),
}));
import { getPublicationContent, grantImportReward, foldPublicationFingerprint } from '@/lib/credits/import-reward';
import { createHash } from 'node:crypto';

const doc = (content: string, path = 'intro.md', ownerUserId: string | null = null) => ({
  path, ownerUserId, status: 'PROCESSED', content, contentRef: null,
});
const baseRepo = { id: 'r', owner: 'o', repo: 'r', branch: 'main', edition: '', isPublic: true, reviewStatus: 'APPROVED', publishedAt: new Date() };
let readContent: () => ReturnType<typeof getPublicationContent>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockExecuteSidecarImportRewardGrant.mockImplementation(async (params: { amount: number }) => ({
    granted: true,
    amount: params.amount,
  }));
  db.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  db.document.findMany.mockResolvedValue([doc('x'.repeat(3000))]);
  readContent = () => getPublicationContent(prisma, 'r', 'u');
  const content = await readContent();
  db.repository.findUnique.mockResolvedValue({ ...baseRepo, reviewPipeline: { publication: { userId: 'u', contentHash: content.contentHash } } });
  db.creditGrantLedger.findFirst.mockResolvedValue(null);
  db.pendingCreditGrant.findFirst.mockResolvedValue(null);
  db.notification.findFirst.mockResolvedValue(null);
  db.repository.update.mockResolvedValue({});
  db.importJob.findMany.mockResolvedValue([{ params: { publishRequested: true }, result: { repositoryId: 'r' } }]);
});

describe('reviewed import reward', () => {
  it('streaming fingerprint is byte-identical to the legacy JSON.stringify hash', async () => {
    const cases: Array<{ path: string; status: string; content: string }>[] = [
      [],
      [{ path: 'intro.md', status: 'PROCESSED', content: 'x'.repeat(3000) }],
      [
        { path: 'a.md', status: 'PROCESSED', content: '中文😀内容' },
        { path: 'b.md', status: 'PROCESSED', content: 'quotes " and \\ backslash\ttab' },
        { path: 'c.md', status: 'PROCESSED', content: 'Content not found.' },
      ],
    ];
    for (const entries of cases) {
      // 旧实现：整仓 JSON.stringify 后一次哈希（发布快照的存量口径，不可变更）
      const legacy = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      const folded = await foldPublicationFingerprint(entries.length > 0, entries);
      expect(folded.contentHash).toBe(legacy);
    }
  });

  it('two-phase content loading batches phase-2 queries instead of one full load', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => doc(`c${i}`, `p${i}.md`));
    db.document.findMany.mockImplementation(async (args?: { where?: { path?: { in?: string[] } } }) => {
      const batch = args?.where?.path?.in;
      if (!batch) return rows.map((r) => ({ path: r.path })); // phase 1 thin
      return rows.filter((r) => batch.includes(r.path)); // phase 2 content
    });
    db.document.findMany.mockClear(); // 排除 beforeEach readContent 的调用计数
    const content = await getPublicationContent(prisma, 'r', 'u');
    // 'c0'..'c249'：10×2 + 90×3 + 150×4 = 890 个 code point
    expect(content).toMatchObject({ ready: true, docCount: 250, totalChars: 890 });
    // 1 次薄行 + ceil(250/100)=3 次分批内容
    expect(db.document.findMany).toHaveBeenCalledTimes(4);
  });

  it('counts Unicode code points from content layer, not UTF-16 or UTF-8', async () => {
    db.document.findMany.mockResolvedValue([{ ...doc('legacy'), contentRef: { content: '中😀a' } }]);
    expect(await readContent()).toMatchObject({ ready: true, totalChars: 3 });
  });

  it('shared path wins and no duplicate private content is counted', async () => {
    db.document.findMany.mockResolvedValue([doc('private', 'a', 'u'), doc('shared', 'a')]);
    expect(await readContent()).toMatchObject({ totalChars: 6, docCount: 1 });
  });

  it.each(['', '   ', 'Content not found.'])('rejects empty or placeholder content %j', async (content) => {
    db.document.findMany.mockResolvedValue([doc(content)]);
    expect(await readContent()).toMatchObject({ ready: false, totalChars: 0 });
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it('writes wallet, IMPORT_REWARD and valuation in the same repository-locked transaction', async () => {
    expect(await grantImportReward('r')).toBe(2);
    expect(mockExecuteSidecarImportRewardGrant).toHaveBeenCalledWith({
      repositoryId: 'r',
      userId: 'u',
      amount: 2,
      owner: 'o',
      repo: 'r',
    });
  });

  it.each([
    { teachingDepth: 'deep' },
    { teachingDepth: 'overview', repoProfile: { ingestMode: 'code_only' } },
  ])('code teaching applies 2x to real Unicode code points, capped at 300: %j', async (options) => {
    db.importJob.findMany.mockResolvedValue([{ params: { publishRequested: true, options }, result: { repositoryId: 'r' } }]);
    for (const [count, expected] of [[1500, 2], [225001, 300]]) {
      db.document.findMany.mockResolvedValue([doc('😀'.repeat(count))]);
      const content = await readContent();
      db.repository.findUnique.mockResolvedValue({ ...baseRepo, reviewPipeline: { publication: { userId: 'u', contentHash: content.contentHash } } });
      expect(await grantImportReward('r')).toBe(expected);
      expect(mockExecuteSidecarImportRewardGrant).toHaveBeenLastCalledWith(
        expect.objectContaining({ amount: expected })
      );
    }
  });

  it('existing IMPORT_REWARD prevents rewards across jobs and re-publication', async () => {
    db.creditGrantLedger.findFirst.mockResolvedValue({ id: 'old-grant' });
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it('existing PendingCreditGrant (even with 0 immediate reward) prevents duplicate rewards', async () => {
    db.creditGrantLedger.findFirst.mockResolvedValue(null);
    db.pendingCreditGrant.findFirst.mockResolvedValue({ id: 'pending-grant-1' });
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it.each([
    { isPublic: false }, { reviewStatus: 'PENDING' }, { reviewStatus: 'REJECTED' },
    { publishedAt: null }, { reviewPipeline: null },
  ])('does not pay without reviewed publication %j', async (override) => {
    db.repository.findUnique.mockResolvedValue({ ...baseRepo, ...override });
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it('content changed after approval must be reviewed again', async () => {
    db.document.findMany.mockResolvedValue([doc('different')]);
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it('a failed or unrequested import cannot claim a reward', async () => {
    db.importJob.findMany.mockResolvedValue([{ params: { publishRequested: false }, result: { repositoryId: 'r' } }]);
    expect(await grantImportReward('r')).toBe(0);
    db.importJob.findMany.mockResolvedValue([]);
    expect(await grantImportReward('r')).toBe(0);
    expect(mockExecuteSidecarImportRewardGrant).not.toHaveBeenCalled();
  });

  it('valuation write failure rejects the transaction rather than committing a partial payment', async () => {
    mockExecuteSidecarImportRewardGrant.mockRejectedValueOnce(new Error('valuation unavailable'));
    await expect(grantImportReward('r')).rejects.toThrow('valuation unavailable');
  });
});
