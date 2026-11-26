import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { ENGINE_CONFIG } from '@/lib/config';
import { checkRepoLimit, repoLimitErrorResponse } from '@/lib/tiers';
import { resolveEditionForKey } from '@/lib/edition';
import { WEB_DOC_OWNER, normalizeCategory } from '@/lib/constants';
import { IMPORT_JOB_STATUS } from '@/lib/schemas/import-job';
import { createImportJob, scheduleImportJob } from '@/lib/jobs/import-job-store';
import { getActiveTagRegistry, canonicalizeTag, classifyTags, syncTagsToRegistry, resolveDraftTags, reconcileCategoryWithEvidence, FALLBACK_CATEGORY } from '@/lib/tag-registry';
import { repoCategoryInputSchema, repoTagsInputSchema } from '@/lib/validations/tag-registry';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { assert } from '@/lib/api/server/api-guards';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';

export const dynamic = 'force-dynamic';

export const POST = defineRoute({
  scope: 'POST /api/ingest',
  auth: 'user',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.ingestMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.ingestWindowMs,
    identifier: ({ userId }) => `ingest:${userId ?? 'anonymous'}`,
  },
  handler: async ({ request, userId }) => {
    assert(!(await isEmergencyReadOnly()), 'SERVICE_UNAVAILABLE');

    const req = request as NextRequest;
    const body = await req.json();
    let { owner, repo, branch, prefixFilter, prefix, useAi, menuStyle, targetLanguage, customPrompt, transcriptionPreset, editionLabel, aiGranularity, aiCondensation, teachingDepth, category, tags, customOutline, outline, repoUrl, versionLabel, customExtensions, starCount, profile, versions, currentSha, draftOutline } = body;

    assert(body.isPublic === undefined || typeof body.isPublic === 'boolean', 'INVALID_PARAM');
    const publishRequested = body.isPublic === true;
    // Force private on ingest so publication cannot bypass License Gate and security review.
    const isPublic = false;

    if (!owner || !repo) {
      if (repoUrl && typeof repoUrl === 'string') {
        const clean = repoUrl.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
        const parts = clean.split('/');
        if (parts.length >= 2) {
          owner = parts[0];
          repo = parts[1];
        }
      }
    }
    const finalPrefixFilter = prefixFilter !== undefined ? prefixFilter : (prefix !== undefined ? prefix : '');
    const finalUseAi = useAi !== undefined ? useAi : (menuStyle === 'ai');
    const finalCustomOutline = customOutline !== undefined ? customOutline : outline;
    const finalBranch = branch || ENGINE_CONFIG.defaultBranch;

    assert(owner && repo, 'INVALID_PARAM', 'Missing owner/repo');

    const { canonicalizeRepo } = await import('@/lib/repo-dedup');
    const canonical = canonicalizeRepo(owner, repo);
    owner = canonical.owner;
    repo = canonical.repo;

    const degradations: string[] = [];
    let probedDescription = '';
    if ((typeof starCount !== 'number' || starCount <= 0 || !(profile as Record<string, unknown> | undefined)?.description) && owner !== WEB_DOC_OWNER) {
      try {
        const { fetchRepoMeta } = await import('@/lib/scout/pipeline/repo-meta');
        const { meta } = await fetchRepoMeta(owner, repo, userId);
        if ((typeof starCount !== 'number' || starCount <= 0) && meta.starCount > 0) {
          starCount = meta.starCount;
        }
        if (meta.description?.trim()) {
          probedDescription = meta.description.trim();
        }
      } catch (err) {
        console.warn('[ingest] starCount probe failed:', err);
        degradations.push('starCount');
      }
    }

    const edition = resolveEditionForKey(body);

    const activeJob = await prisma.importJob.findFirst({
      where: {
        owner,
        repo,
        branch: finalBranch,
        edition,
        status: { in: [IMPORT_JOB_STATUS.QUEUED, IMPORT_JOB_STATUS.RUNNING] },
      },
      select: { id: true, userId: true },
    });
    if (activeJob && activeJob.userId === userId) {
      return ok({ jobId: activeJob.id, ...(edition ? { edition } : {}), deduped: true }, 202);
    }

    const preExistingRepo = await prisma.repository.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        repo: { equals: repo, mode: 'insensitive' },
        branch: finalBranch,
        edition,
      },
      select: {
        id: true,
        isPublic: true,
        documents: { select: { id: true }, take: 1 },
      },
    });
    const hasExistingDocs = (preExistingRepo?.documents?.length ?? 0) > 0;
    if (preExistingRepo && hasExistingDocs && !edition) {
      assert(
        false,
        'CONFLICT',
        `${owner}/${repo} tutorial already exists. Please create a new edition instead of overwriting the primary tutorial.`
      );
    }

    if (edition && preExistingRepo && hasExistingDocs) {
      const ownRecord = await prisma.importRecord.findFirst({
        where: { userId, repositoryId: preExistingRepo.id },
        select: { id: true },
      });
      assert(!!ownRecord, 'CONFLICT', `edition ${edition} is owned by another user`);
    }

    const tierUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true, role: true },
    });
    const repoLimit = await checkRepoLimit(userId, {
      role: tierUser?.role,
      tier: tierUser?.tier,
      targetRepo: { owner, repo },
    });
    if (!repoLimit.allowed) {
      return NextResponse.json(repoLimitErrorResponse(userId, repoLimit), { status: 403 });
    }

    const tagRegistry = await getActiveTagRegistry();
    const draftTags = await resolveDraftTags(draftOutline);
    const rawCategory = repoCategoryInputSchema.safeParse(category).success ? String(category).trim() : undefined;
    const normalizedCategory = rawCategory ? normalizeCategory(rawCategory) : undefined;
    const candidateCategory = normalizedCategory
      ? (canonicalizeTag(normalizedCategory, tagRegistry, 'CATEGORY') ?? canonicalizeTag(rawCategory!, tagRegistry, 'CATEGORY') ?? FALLBACK_CATEGORY)
      : (draftTags.category ?? FALLBACK_CATEGORY);
    const rawTags = (repoTagsInputSchema.safeParse(tags).success && Array.isArray(tags) && tags.length > 0)
      ? tags
      : (draftTags.tags ?? []);
    const classifiedTags = classifyTags(rawTags, tagRegistry, 'TAG');
    if (classifiedTags.unknown.length > 0) {
      await syncTagsToRegistry('TAG', classifiedTags.unknown, 'ai');
    }
    const finalTags = classifiedTags.known.concat(classifiedTags.unknown);
    const canonicalCategory = reconcileCategoryWithEvidence({
      category: candidateCategory,
      tags: finalTags,
    });

    let activeModelId = '';
    try {
      const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
      const activeUserModel = await resolveActiveUserModel(userId);
      activeModelId = activeUserModel?.modelId?.trim() || '';
    } catch (err) {
      console.warn('[ingest] active model resolution failed:', err);
      degradations.push('activeModel');
    }
    const resolvedModel =
      (typeof body.transcriptionModel === 'string' && body.transcriptionModel.trim()) ||
      (typeof body.model === 'string' && body.model.trim()) ||
      activeModelId;

    const mergedProfile = {
      ...(profile && typeof profile === 'object' ? profile : {}),
      ...(probedDescription && !(profile as Record<string, unknown> | undefined)?.description
        ? { description: probedDescription }
        : {}),
      ...(resolvedModel ? { transcriptionModel: resolvedModel } : {}),
    };

    const { jobId, deduped } = await createImportJob(
      {
        userId,
        owner,
        repo,
        branch: finalBranch,
        edition,
        params: {
        userId,
        branch: finalBranch,
        edition,
        frozenCredits: 0,
        degradations: degradations.length > 0 ? degradations : undefined,
        publishRequested,
        preExistingRepo: preExistingRepo ? { id: preExistingRepo.id, isPublic: preExistingRepo.isPublic } : null,
        options: {
          prefixFilter: finalPrefixFilter,
          useAi: finalUseAi,
          targetLanguage,
          customPrompt,
          transcriptionPreset,
          model: resolvedModel || undefined,
          transcriptionModel: resolvedModel || undefined,
          edition,
          editionLabel,
          aiGranularity,
          aiCondensation,
          teachingDepth,
          isPublic,
          category: canonicalCategory,
          tags: finalTags,
          customOutline: finalCustomOutline,
          versionLabel,
          customExtensions,
          starCount,
          repoProfile: mergedProfile,
          versions,
          gitSha: currentSha ?? undefined,
          draftOutline,
        },
        },
      }
    );

    if (deduped) {
      return ok({ jobId, ...(edition ? { edition } : {}), deduped: true }, 202);
    }

    await scheduleImportJob(jobId);

    return ok({ jobId, ...(edition ? { edition } : {}) }, 202);
  },
});
