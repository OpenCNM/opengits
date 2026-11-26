import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { CREDITS_CONFIG, estimateRequiredCredits } from '@/lib/credits-config';
import { getDailyCreditsUsage, getResetWindowBounds, validateImportCredits } from '@/lib/credits-ledger';
import { isCodePedagogyBilling, settleImportBilling } from '@/lib/credits/import-billing';
import {
  foldPublicationFingerprint,
  getPublicationContent,
  grantImportReward,
} from '@/lib/credits/import-reward';
import {
  chargeShelfFeeAndSave,
  computeShelfFee,
  isShelfFeeExempt,
  resolveEffectiveShelfFee,
} from '@/lib/credits/shelf-fee';
import { executeSidecarCreditsLedger } from '@/engine/credits-driver';
import { CHAPTER_UPDATE_JOB_STATUS } from '@/lib/schemas/update-job';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Credits & Economic Ledger Temporal Sequence Integration Suite.
 *
 * Supersedes mocked unit tests:
 * - credits-budget-and-ledger, credits-defaults-parity, credits-dynamic-config,
 *   credits-earn, credits-ledger, credits-race-temporal, credits-shelf-and-gift,
 *   api-user-credits.
 */

describe('Credits Policy, Billing Formulas, Fingerprint & Go/TS Parity (Non-DB)', () => {
  it('maintains zero drift between TS CREDITS_CONFIG and Go settle.go defaults', () => {
    const settleGoPath = join(__dirname, '../../services/worker-sidecar/internal/jobs/settle.go');
    const src = readFileSync(settleGoPath, 'utf-8');
    const match = src.match(/creditsConfigDefaults = settleCreditsDefaults\{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();

    const goDefaults: Record<string, number | boolean> = {};
    for (const line of match![1].split('\n')) {
      const kv = line.match(/^\s*(\w+):\s+(-?[\d.]+|true|false),/);
      if (kv) {
        goDefaults[kv[1]] = kv[2] === 'true' || kv[2] === 'false' ? kv[2] === 'true' : Number(kv[2]);
      }
    }

    const pairs: Array<[keyof typeof CREDITS_CONFIG, string]> = [
      ['DEFAULT_DAILY_CREDITS', 'defaultDailyCredits'],
      ['DEFAULT_RESET_INTERVAL_HOURS', 'resetIntervalHours'],
      ['MAX_CREDITS_PER_IMPORT', 'maxCreditsPerImport'],
      ['STANDARD_CHUNK_CHAR_SIZE', 'standardChunkCharSize'],
      ['CODE_PEDAGOGY_MULTIPLIER', 'codePedagogyMulti'],
      ['PUBLISH_GIFT_ENABLED', 'publishGiftEnabled'],
    ];
    expect(Object.keys(goDefaults).sort()).toEqual(pairs.map(([, g]) => g).sort());
    for (const [tsKey, goKey] of pairs) {
      expect(goDefaults[goKey]).toBe(CREDITS_CONFIG[tsKey]);
    }
  });

  it('aligns reset windows and computes import billing + shelf fee formulas deterministically', async () => {
    const t = new Date('2026-06-15T13:45:00.000Z');
    const bounds = getResetWindowBounds(t, 24);
    expect(bounds.start.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(bounds.nextResetAt.toISOString()).toBe('2026-06-16T00:00:00.000Z');
    expect(bounds.end.getTime()).toBe(bounds.nextResetAt.getTime() - 1);

    expect(isCodePedagogyBilling({ teachingDepth: 'deep', ingestMode: 'text_only' })).toBe(true);
    expect(isCodePedagogyBilling({ teachingDepth: 'overview', ingestMode: 'code_only' })).toBe(true);
    expect(isCodePedagogyBilling({ teachingDepth: 'overview', ingestMode: 'text_only' })).toBe(false);

    const cfg = {
      defaultDailyCredits: 1000,
      resetIntervalHours: 24,
      maxCreditsPerImport: 300,
      codePedagogyMultiplier: 2,
      standardChunkCharSize: 1500,
      webDocMaxPages: 200,
      publishGiftEnabled: false,
      shelfFeeMultiplier: 1,
      contributionVestingDays: 7,
      initialPublishRewardRatio: 0,
    };

    const settledPublic = settleImportBilling({
      actualDocCount: 2,
      actualChars: 3100,
      isPublic: true,
      teachingDepth: 'deep',
      config: cfg,
    });
    expect(settledPublic.estimatedChunks).toBe(3);
    expect(settledPublic.baseCredits).toBe(6);
    expect(settledPublic.rewardCredits).toBe(6);
    expect(settledPublic.finalCredits).toBe(0);

    const settledPrivate = settleImportBilling({
      actualDocCount: 2,
      actualChars: 3100,
      isPublic: false,
      config: cfg,
    });
    expect(settledPrivate.rewardCredits).toBe(0);

    const est = estimateRequiredCredits({ totalChars: 100, docCount: 3, isPublic: true }, cfg);
    expect(est.estimatedChunks).toBe(3);
    expect(est.finalCredits).toBe(0);

    expect(computeShelfFee(80, 1, 0)).toBe(80);
    expect(computeShelfFee(0, 1, 5)).toBe(3); // ceil(5 * 0.5) = 3
    expect(computeShelfFee(80, 0, 5)).toBe(0);
    expect(resolveEffectiveShelfFee({ shelfFeeOverride: 0, transcriptionCreditsEarned: 80, shelfFeeMultiplier: 1 })).toBe(0);
    expect(resolveEffectiveShelfFee({ shelfFeeOverride: 42, transcriptionCreditsEarned: 80, shelfFeeMultiplier: 1 })).toBe(42);

    async function* genEntries() {
      yield { path: 'a.md', status: 'PROCESSED', content: 'hello' };
      yield { path: 'b.md', status: 'PROCESSED', content: 'world' };
    }
    const fp = await foldPublicationFingerprint(true, genEntries());
    expect(fp.ready).toBe(true);
    expect(fp.docCount).toBe(2);
    expect(fp.totalChars).toBe(10);
    expect(fp.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'Credits Economic Lifecycle & Concurrent CAS Races (Real DB + Sidecar)',
  () => {
    const createdUserIds: string[] = [];
    const createdRepoIds: string[] = [];
    const createdJobIds: string[] = [];

    afterAll(async () => {
      if (createdRepoIds.length > 0) {
        await prisma.pendingCreditGrant.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.creditGrantLedger.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.savedRepo.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.importRecord.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.chapterUpdateJob.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.document.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
      if (createdJobIds.length > 0) {
        await prisma.importJob.deleteMany({ where: { id: { in: createdJobIds } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('enforces single-grant idempotency for grantImportReward & queries unified ledger', async () => {
      const creator = await createTestUser('cred-creator', { creditBalance: 0 });
      createdUserIds.push(creator.id);

      const owner = uniqueTestTag('cred-owner');
      const repoName = uniqueTestTag('cred-repo');
      const branch = ENGINE_CONFIG.defaultBranch;

      const repo = await prisma.repository.create({
        data: {
          owner,
          repo: repoName,
          branch,
          edition: '',
          isPublic: true,
          reviewStatus: 'APPROVED',
          publishedAt: new Date(),
        },
      });
      createdRepoIds.push(repo.id);

      await prisma.document.create({
        data: {
          repositoryId: repo.id,
          path: 'docs/guide.md',
          title: 'Guide',
          status: 'PROCESSED',
          content: 'A'.repeat(3200),
        },
      });

      const snapshot = await getPublicationContent(prisma, repo.id, creator.id);
      expect(snapshot.ready).toBe(true);

      await prisma.repository.update({
        where: { id: repo.id },
        data: {
          reviewPipeline: {
            publication: { userId: creator.id, contentHash: snapshot.contentHash },
          },
        },
      });

      const job = await prisma.importJob.create({
        data: {
          userId: creator.id,
          owner,
          repo: repoName,
          branch,
          edition: '',
          status: 'COMPLETED',
          params: { kind: 'repo', publishRequested: true, options: { teachingDepth: 'deep' } },
          result: { repositoryId: repo.id },
        },
      });
      createdJobIds.push(job.id);

      // Concurrent reward calls -> at most 1 grant total
      const grants = await Promise.all([
        grantImportReward(repo.id),
        grantImportReward(repo.id),
        grantImportReward(repo.id),
      ]);
      const positive = grants.filter((g) => g > 0);
      expect(positive).toHaveLength(1);
      expect(grants.reduce((sum, x) => sum + x, 0)).toBe(positive[0]);

      // Subsequent call is strictly idempotent (0)
      expect(await grantImportReward(repo.id)).toBe(0);

      // Usage & ledger endpoint agree with persisted state
      const usage = await getDailyCreditsUsage(creator.id);
      const allowed = await validateImportCredits(creator.id, 999);
      expect(allowed.allowed).toBe(true);
      expect(usage.usedCredits).toBe(0);

      const ledger = await executeSidecarCreditsLedger(creator.id, 1, 20);
      expect(ledger.balance).toBe(usage.creditBalance);
    });

    it('prevents overdraft and double-spend under 8-way concurrent shelf fee charges', async () => {
      const buyer = await createTestUser('cred-buyer', { creditBalance: 100 });
      const broke = await createTestUser('cred-broke', { creditBalance: 50 });
      const contributor = await createTestUser('cred-contrib', { creditBalance: 10 });
      createdUserIds.push(buyer.id, broke.id, contributor.id);

      const repo = await prisma.repository.create({
        data: {
          owner: uniqueTestTag('shelf-owner'),
          repo: uniqueTestTag('shelf-repo'),
          branch: ENGINE_CONFIG.defaultBranch,
          isPublic: true,
          transcriptionCreditsEarned: 80,
          shelfFeeOverride: 80,
        },
      });
      createdRepoIds.push(repo.id);

      const doc = await prisma.document.create({
        data: { repositoryId: repo.id, path: 'README.md', title: 'README', status: 'PROCESSED', content: 'hi' },
      });

      // Contributor exemption via SWAPPED ChapterUpdateJob
      await prisma.chapterUpdateJob.create({
        data: {
          repositoryId: repo.id,
          documentId: doc.id,
          path: 'README.md',
          fromSha: '1111111111111111111111111111111111111111',
          toSha: '1111111111111111111111111111111111111111',
          kind: 'RELAY',
          status: CHAPTER_UPDATE_JOB_STATUS.SWAPPED,
          claimedBy: contributor.id,
        },
      });
      expect(await isShelfFeeExempt(contributor.id, repo.id)).toBe(true);
      const contribCharge = await chargeShelfFeeAndSave(contributor.id, repo.id);
      expect(contribCharge).toMatchObject({ ok: true, fee: 0 });
      const contribUser = await prisma.user.findUnique({ where: { id: contributor.id } });
      expect(contribUser?.creditBalance).toBe(10);

      // 8-way concurrent race for buyer (balance 100, fee 80) ->
      // Under Postgres READ COMMITTED + SELECT FOR UPDATE:
      // - exactly 1 winner pays 80 -> balance 20
      // - remaining 7 either hit SavedRepo (alreadySaved: true) or fail-closed on LockUserBalance (INSUFFICIENT_BALANCE)
      const raceResults = await Promise.all(
        Array.from({ length: 8 }, () => chargeShelfFeeAndSave(buyer.id, repo.id))
      );
      const paidOnce = raceResults.filter((r) => r.ok && r.fee === 80 && !r.alreadySaved);
      const idempotentOrBlocked = raceResults.filter(
        (r) => (r.ok && r.alreadySaved) || (!r.ok && r.code === 'INSUFFICIENT_BALANCE')
      );
      expect(paidOnce).toHaveLength(1);
      expect(idempotentOrBlocked).toHaveLength(7);

      const buyerAfter = await prisma.user.findUnique({ where: { id: buyer.id } });
      expect(buyerAfter?.creditBalance).toBe(20);
      const savedRows = await prisma.savedRepo.findMany({
        where: { userId: buyer.id, repositoryId: repo.id },
      });
      expect(savedRows).toHaveLength(1);
      expect(savedRows[0].paidCredits).toBe(80);

      // Insufficient balance (50 < 80) -> fail-closed with 0 SavedRepo rows
      const brokeResults = await Promise.all([
        chargeShelfFeeAndSave(broke.id, repo.id),
        chargeShelfFeeAndSave(broke.id, repo.id),
      ]);
      for (const r of brokeResults) {
        expect(r).toMatchObject({ ok: false, code: 'INSUFFICIENT_BALANCE', fee: 80, balance: 50 });
      }
      const brokeAfter = await prisma.user.findUnique({ where: { id: broke.id } });
      expect(brokeAfter?.creditBalance).toBe(50);
      expect(
        await prisma.savedRepo.count({ where: { userId: broke.id, repositoryId: repo.id } })
      ).toBe(0);
    });
  }
);
