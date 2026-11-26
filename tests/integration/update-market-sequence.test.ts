import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import {
  codeChapterPath,
  clusterChapterNo,
  isCodeChapterPath,
  type UpdateCandidateSet,
} from '@/engine/update-candidate-set';
import {
  applyUpdatePlan,
  coercePlanDraft,
  decideExecutionStrategy,
  MAX_PLAN_ITEMS,
  UpdatePlanValidationError,
  validatePlan,
} from '@/engine/update-applier';
import type { UpdatePlan } from '@/engine/update-planner';
import {
  abandonClaim,
  claimJob,
  ensureRelayJobForDocument,
  runStagedTranscription,
  UpdateMarketError,
} from '@/lib/update-market/jobs';
import {
  executeSidecarMarketJobExtendClaim,
  executeSidecarMarketJobRelaySettle,
} from '@/engine/market-driver';
import { CHAPTER_UPDATE_JOB_STATUS } from '@/lib/schemas/update-job';
import { resolveRepository } from '@/lib/repository-resolver';
import { computeUpdateFunnelMetrics } from '@/engine/analytics/update-funnel';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Update Market & Incremental Plan/Apply Temporal Sequence Integration Suite.
 *
 * Supersedes mocked unit tests:
 * - update-applier, update-candidate-driver, update-candidate-set,
 *   update-edition-branch-resolution, update-funnel-analytics,
 *   update-jobs-batch-claim, update-jobs-claim-transcribe, update-jobs-list-api,
 *   update-market-jobs, update-market-lease-temporal, update-planner-remove-guard,
 *   update-planner, update-rename-migration, update-strategy-routing.
 */

function makeCandidateSetFixture(overrides: Partial<UpdateCandidateSet> = {}): UpdateCandidateSet {
  return {
    chapters: [
      {
        path: 'docs/old-name.md',
        title: 'Old Name',
        oldSummary: 'old summary',
        change: 'content',
        affectedFiles: [{ path: 'docs/old-name.md', change: 'renamed' }],
        rename: { from: 'docs/old-name.md', to: 'docs/new-name.md' },
      },
      {
        path: 'docs/intro.md',
        title: 'Intro',
        oldSummary: 'intro summary',
        change: 'content',
        affectedFiles: [{ path: 'docs/intro.md', change: 'modified' }],
      },
      {
        path: 'docs/to-delete.md',
        title: 'To Delete',
        oldSummary: 'delete summary',
        change: 'structural',
        affectedFiles: [{ path: 'docs/to-delete.md', change: 'removed' }],
      },
    ],
    unmatchedFiles: [{ path: 'docs/added.md', change: 'added' }],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 1, modified: 1, removed: 1, renamed: 1 },
    hasOldArchive: true,
    ...overrides,
  };
}

describe('Update Planner Coercion, Validation & Strategy Routing (Non-DB)', () => {
  it('computes deterministic code chapter paths & cluster chapter numbers', () => {
    expect(codeChapterPath(1)).toBe('chapters/01.mdx');
    expect(codeChapterPath(12)).toBe('chapters/12.mdx');
    expect(clusterChapterNo({ teachingOrder: 3, chapterNo: 7 })).toBe(7);
    expect(clusterChapterNo({ teachingOrder: 3 })).toBe(3);
    expect(isCodeChapterPath('chapters/01.mdx')).toBe(true);
    expect(isCodeChapterPath('docs/intro.md')).toBe(false);
  });

  it('coerces rename hallucinations to DROP and ungrounded removes to update, preserving true Git removes', () => {
    const candidateSet = makeCandidateSetFixture();
    const rawPlan: UpdatePlan = {
      summary: 'Mixed LLM draft',
      chapters: [
        { path: 'docs/old-name.md', action: 'remove', reason: 'rename misclassified as remove' },
        { path: 'docs/intro.md', action: 'remove', reason: 'hallucinated delete on modified file' },
        { path: 'docs/to-delete.md', action: 'remove', reason: 'real upstream removal' },
        { path: 'docs/added.md', action: 'add', title: 'Added Chapter', reason: 'new file' },
      ],
    };

    const { plan, coerced } = coercePlanDraft(rawPlan, candidateSet);
    expect(coerced).toHaveLength(2);
    expect(coerced[0]).toMatchObject({ path: 'docs/old-name.md', toAction: 'DROP' });
    expect(coerced[1]).toMatchObject({ path: 'docs/intro.md', fromAction: 'remove', toAction: 'update' });
    expect(plan.chapters.find((c) => c.path === 'docs/old-name.md')).toBeUndefined();
    expect(plan.chapters.find((c) => c.path === 'docs/intro.md')?.action).toBe('update');
    expect(plan.chapters.find((c) => c.path === 'docs/to-delete.md')?.action).toBe('remove');

    // Coerced plan passes validatePlan
    expect(() => validatePlan(plan, candidateSet)).not.toThrow();
  });

  it('routes high true-remove ratio to MAJOR_VERSION_REBUILD and enforces validatePlan bounds', () => {
    const candidateSet = makeCandidateSetFixture();
    const smallRemovePlan: UpdatePlan = {
      summary: 'small',
      chapters: [{ path: 'docs/to-delete.md', action: 'remove', reason: 'removed' }],
    };
    expect(decideExecutionStrategy(smallRemovePlan, candidateSet, 10).strategy).toBe('INCREMENTAL_PATCH');
    const singleChapterCandidateSet = makeCandidateSetFixture({
      chapters: [
        {
          path: 'docs/to-delete.md',
          title: 'To Delete',
          oldSummary: 'delete summary',
          change: 'structural',
          affectedFiles: [{ path: 'docs/to-delete.md', change: 'removed' }],
        },
      ],
    });
    expect(decideExecutionStrategy(smallRemovePlan, singleChapterCandidateSet, 1).strategy).toBe('MAJOR_VERSION_REBUILD');

    // Out-of-candidate mutation must fail validation
    expect(() =>
      validatePlan(
        { summary: 'bad', chapters: [{ path: 'docs/unauthorized.md', action: 'update', reason: 'x' }] },
        candidateSet
      )
    ).toThrow(UpdatePlanValidationError);

    expect(() =>
      validatePlan(
        { summary: 'bad-add', chapters: [{ path: 'docs/not-added.md', action: 'add', reason: 'x' }] },
        candidateSet
      )
    ).toThrow(UpdatePlanValidationError);

    const oversized = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => ({
      path: `docs/f-${i}.md`,
      action: 'update' as const,
      reason: 'bulk',
    }));
    expect(() => validatePlan({ summary: 'too big', chapters: oversized }, candidateSet)).toThrow(
      UpdatePlanValidationError
    );
  });
});

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'Update Market, Apply Plan & Edition Resolution Sequence (Real DB + Sidecar)',
  () => {
    const createdUserIds: string[] = [];
    const createdRepoIds: string[] = [];
    const createdContentIds: string[] = [];

    afterAll(async () => {
      if (createdRepoIds.length > 0) {
        await prisma.chapterVersionVote.deleteMany({
          where: { version: { repositoryId: { in: createdRepoIds } } },
        }).catch(() => {});
        await prisma.chapterVersion.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.chapterUpdateJob.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.importRecord.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.importUpdateRun.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.tutorialOutline.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.document.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
      if (createdContentIds.length > 0) {
        await prisma.documentContent.deleteMany({ where: { id: { in: createdContentIds } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('resolves editions fail-closed and applies plan atomically with rename migration & idempotency', async () => {
      const maintainer = await createTestUser('upd-maint');
      createdUserIds.push(maintainer.id);

      const owner = uniqueTestTag('upd-owner');
      const repoName = uniqueTestTag('upd-repo');
      const branch = ENGINE_CONFIG.defaultBranch;
      const fromSha = '1111111111111111111111111111111111111111';
      const toSha = '2222222222222222222222222222222222222222';

      const baseRepo = await prisma.repository.create({
        data: {
          owner,
          repo: repoName,
          branch,
          edition: '',
          gitSha: fromSha,
          isPublic: true,
          hasUpstreamUpdate: true,
          navTree: [
            { name: 'intro', title: 'Intro', type: 'file', path: 'docs/intro.md', url: `/docs/${owner}/${repoName}/docs/intro` },
            { name: 'old-name', title: 'Old Name', type: 'file', path: 'docs/old-name.md', url: `/docs/${owner}/${repoName}/docs/old-name` },
            { name: 'to-delete', title: 'To Delete', type: 'file', path: 'docs/to-delete.md', url: `/docs/${owner}/${repoName}/docs/to-delete` },
          ],
        },
      });
      const deepRepo = await prisma.repository.create({
        data: {
          owner,
          repo: repoName,
          branch,
          edition: 'deep',
          gitSha: fromSha,
          isPublic: true,
        },
      });
      createdRepoIds.push(baseRepo.id, deepRepo.id);

      // Edition resolution checks
      const hitDeep = await resolveRepository(owner, repoName, branch, 'deep');
      expect(hitDeep?.repository.id).toBe(deepRepo.id);
      expect(hitDeep?.resolvedEdition).toBe('deep');
      expect(hitDeep?.editionMiss).toBeUndefined();

      const missEdition = await resolveRepository(owner, repoName, branch, 'nonexistent-ed');
      expect(missEdition?.editionMiss).toEqual({ requested: 'nonexistent-ed' });
      expect(missEdition?.repository.id).toBe(baseRepo.id);

      // Seed docs in baseRepo
      await prisma.document.createMany({
        data: [
          { repositoryId: baseRepo.id, path: 'docs/intro.md', title: 'Intro', content: 'old intro', status: 'PROCESSED', gitSha: fromSha },
          { repositoryId: baseRepo.id, path: 'docs/old-name.md', title: 'Old Name', content: 'preserved rename content', status: 'PROCESSED', gitSha: fromSha },
          { repositoryId: baseRepo.id, path: 'docs/to-delete.md', title: 'To Delete', content: 'bye', status: 'PROCESSED', gitSha: fromSha },
        ],
      });

      const candidateSet = makeCandidateSetFixture();
      const rawPlan: UpdatePlan = {
        summary: 'Apply update sequence',
        chapters: [
          { path: 'docs/old-name.md', action: 'update', reason: 'LLM wrongly marked rename as update' },
          { path: 'docs/intro.md', action: 'update', reason: 'modified upstream' },
          { path: 'docs/to-delete.md', action: 'remove', reason: 'deleted upstream' },
          { path: 'docs/added.md', action: 'add', title: 'Added', reason: 'added upstream' },
        ],
      };

      const res1 = await applyUpdatePlan({
        repositoryId: baseRepo.id,
        userId: maintainer.id,
        docOwnerId: null,
        fromSha,
        toSha,
        plan: rawPlan,
        candidateSet,
      });

      expect(res1.renamedDocs).toBe(1);
      expect(res1.updatedDocs).toBe(1);
      expect(res1.removedDocs).toBe(1);
      expect(res1.addedDocs).toBe(1);
      expect(res1.gitShaAdvanced).toBe(true);
      expect(res1.coercedActions).toBeGreaterThanOrEqual(1);

      const docsAfter = await prisma.document.findMany({
        where: { repositoryId: baseRepo.id, ownerUserId: null },
      });
      const byPath = new Map(docsAfter.map((d) => [d.path, d]));
      expect(byPath.get('docs/old-name.md')).toBeUndefined();
      expect(byPath.get('docs/new-name.md')?.status).toBe('PROCESSED');
      expect(byPath.get('docs/intro.md')?.status).toBe('UNPROCESSED');
      expect(byPath.get('docs/to-delete.md')).toBeUndefined();
      expect(byPath.get('docs/added.md')?.status).toBe('UNPROCESSED');

      const repoAfter = await prisma.repository.findUnique({ where: { id: baseRepo.id } });
      expect(repoAfter?.gitSha).toBe(toSha);
      expect(repoAfter?.hasUpstreamUpdate).toBe(false);

      // Re-applying at toSha does not advance gitSha again (structural idempotency)
      const res2 = await applyUpdatePlan({
        repositoryId: baseRepo.id,
        userId: maintainer.id,
        docOwnerId: null,
        fromSha: toSha,
        toSha,
        plan: { summary: 'noop repeat', chapters: [{ path: 'docs/intro.md', action: 'keep', reason: 'already synced' }] },
        candidateSet,
      });
      expect(res2.gitShaAdvanced).toBe(false);
    });

    it('runs ChapterUpdateJob temporal sequence: ensureRelay -> CAS claim -> rival conflict -> extend -> abandon -> re-claim -> settle', async () => {
      const user1 = await createTestUser('mkt-u1');
      const user2 = await createTestUser('mkt-u2');
      createdUserIds.push(user1.id, user2.id);

      const owner = uniqueTestTag('mkt-owner');
      const repoName = uniqueTestTag('mkt-repo');
      const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const repo = await prisma.repository.create({
        data: { owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, gitSha: sha, isPublic: true },
      });
      createdRepoIds.push(repo.id);

      const doc = await prisma.document.create({
        data: {
          repositoryId: repo.id,
          path: 'guide/relay.md',
          title: 'Relay Chapter',
          content: '',
          status: 'UNPROCESSED',
        },
      });

      // 1. ensureRelayJobForDocument is idempotent
      const jobA = await ensureRelayJobForDocument(doc.id);
      const jobB = await ensureRelayJobForDocument(doc.id);
      expect(jobA.id).toBe(jobB.id);
      expect(jobA.kind).toBe('RELAY');
      expect(jobA.status).toBe(CHAPTER_UPDATE_JOB_STATUS.PENDING);

      // 2. Entry guards on PENDING job must fail-closed before any generation
      await expect(runStagedTranscription(jobA.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(runStagedTranscription('nonexistent-job-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // 3. user1 claims job; rival user2 is rejected with UpdateMarketError (409 -> INVALID_STATE / ALREADY_CLAIMED)
      const claim1 = await claimJob(jobA.id, user1.id);
      expect(claim1.frozenCredits).toBe(0);
      await expect(claimJob(jobA.id, user2.id)).rejects.toBeInstanceOf(UpdateMarketError);
      const rivalErr = await claimJob(jobA.id, user2.id).catch((e) => e);
      expect(['ALREADY_CLAIMED', 'INVALID_STATE']).toContain((rivalErr as UpdateMarketError).code);

      // 4. Lease extension CAS: holder succeeds, rival returns false
      expect((await executeSidecarMarketJobExtendClaim(jobA.id, user1.id, 60)).extended).toBe(true);
      expect((await executeSidecarMarketJobExtendClaim(jobA.id, user2.id, 60)).extended).toBe(false);

      // 5. Expired lease guard in runStagedTranscription
      await prisma.chapterUpdateJob.update({
        where: { id: jobA.id },
        data: { claimedUntil: new Date(Date.now() - 10_000) },
      });
      await expect(runStagedTranscription(jobA.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });

      // Restore active lease so user1 can abandon, then user2 claims & settles
      await prisma.chapterUpdateJob.update({
        where: { id: jobA.id },
        data: { claimedUntil: new Date(Date.now() + 600_000) },
      });
      await abandonClaim(jobA.id, user1.id);

      await claimJob(jobA.id, user2.id);

      const stagedContent = await prisma.documentContent.create({
        data: {
          contentHash: uniqueTestTag('relay-hash'),
          content: '# Relay Chapter\n\nSettled canonical MDX content.',
          lang: 'en',
        },
      });
      createdContentIds.push(stagedContent.id);

      await executeSidecarMarketJobRelaySettle({
        jobId: jobA.id,
        userId: user2.id,
        documentId: doc.id,
        repositoryId: repo.id,
        stagedContentId: stagedContent.id,
        stagedModel: 'test-model',
        toSha: sha,
        dualWrite: false,
      });

      const settledJob = await prisma.chapterUpdateJob.findUnique({ where: { id: jobA.id } });
      expect(settledJob?.status).toBe(CHAPTER_UPDATE_JOB_STATUS.SWAPPED);
      expect(settledJob?.claimedBy).toBe(user2.id);

      const settledDoc = await prisma.document.findUnique({ where: { id: doc.id } });
      expect(settledDoc?.status).toBe('PROCESSED');
      expect(settledDoc?.contentId).toBe(stagedContent.id);

      const versions = await prisma.chapterVersion.findMany({ where: { documentId: doc.id } });
      expect(versions.some((v) => v.isCanonical && v.contentId === stagedContent.id)).toBe(true);
    });

    it('computes update funnel metrics cleanly against real DB', async () => {
      const metrics = await computeUpdateFunnelMetrics();
      expect(typeof metrics.overview.totalImpressions).toBe('number');
      expect(metrics.funnelSteps).toHaveLength(4);
    });
  }
);
