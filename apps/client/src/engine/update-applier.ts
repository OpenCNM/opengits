import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { DocumentStatus, REPO_PROFILE_CLUSTERS_KEY } from '../lib/constants';
import { ENGINE_CONFIG } from '../lib/config';
import { callSidecar } from '../lib/sidecar-client';
import { registerImportSnapshot } from './import-snapshot';
import { codeChapterPath, clusterChapterNo, isCodeChapterPath } from './update-candidate-set';
import { patchNavTree, NavTreePatch, NavNode } from './navtree-patch';
import { outlineFromNavTree } from '../lib/mcp/outline-derive';
import { getEffectiveNavTree } from '../lib/mcp/outline-projector';
import { storeOutlineDraft, deactivateAllOutlines } from '../lib/mcp/outline-store';
import type { UpdatePlan, UpdateActionKind } from './update-planner';
import type { UpdateCandidateSet } from './update-candidate-set';
import { executeSidecarUpdateApply } from './update-candidate-driver';

export const MAX_PLAN_ITEMS = 50;

export interface ApplyUpdatePlanParams {
  repositoryId: string;
  userId: string;
  docOwnerId: string | null;
  fromSha: string;
  toSha: string;
  plan: UpdatePlan;
  candidateSet: UpdateCandidateSet;
  runId?: string;
}

export interface ApplyUpdateResult {
  updatedDocs: number;
  removedDocs: number;
  addedDocs: number;
  renamedDocs: number;
  coercedActions: number;
  navTreePatched: boolean;
  gitShaAdvanced: boolean;
}

type UpdateExecutionStrategy = 'INCREMENTAL_PATCH' | 'MAJOR_VERSION_REBUILD';

interface StrategyDecision {
  strategy: UpdateExecutionStrategy;
  trueRemoves: number;
  realRemoveRatio: number;
  totalChapters: number;
  reason: string;
}

interface CoercedAction {
  path: string;
  fromAction: UpdateActionKind;
  toAction: UpdateActionKind | 'DROP';
  reason: string;
}

interface CoercePlanResult {
  plan: UpdatePlan;
  coerced: CoercedAction[];
}

export class UpdatePlanValidationError extends Error {}

function isGitTrueRemove(path: string, candidateSet: UpdateCandidateSet): boolean {
  const cand = candidateSet.chapters.find((c) => c.path === path);
  if (!cand) return false;
  if (cand.rename) return false;
  if (candidateSet.structuralRemoves.some((c) => c.path === path)) return true;
  return cand.affectedFiles.length > 0 && cand.affectedFiles.every((f) => f.change === 'removed');
}

// Drops rename chapters (migrated deterministically) and downgrades unverified removes to update so LLM hallucinations never delete live chapters.
export function coercePlanDraft(plan: UpdatePlan, candidateSet: UpdateCandidateSet): CoercePlanResult {
  const coerced: CoercedAction[] = [];
  const chapters = plan.chapters.flatMap((ch) => {
    const cand = candidateSet.chapters.find((c) => c.path === ch.path);
    if (cand?.rename) {
      coerced.push({
        path: ch.path,
        fromAction: ch.action,
        toAction: 'DROP',
        reason: 'rename 由代码迁移路径，LLM 裁决被忽略',
      });
      return [];
    }
    if (ch.action === 'remove' && !isGitTrueRemove(ch.path, candidateSet)) {
      coerced.push({
        path: ch.path,
        fromAction: 'remove',
        toAction: 'update',
        reason: 'remove 无 Git 事实支撑（源文件未全部删除），矫正为 update',
      });
      return [{ ...ch, action: 'update' as const }];
    }
    return [ch];
  });
  return { plan: { chapters, summary: plan.summary }, coerced };
}

export function decideExecutionStrategy(
  plan: UpdatePlan,
  candidateSet: UpdateCandidateSet,
  totalChapterCount: number
): StrategyDecision {
  const trueRemoves = plan.chapters.filter(
    (ch) => ch.action === 'remove' && isGitTrueRemove(ch.path, candidateSet)
  ).length;
  const denominator = Math.max(totalChapterCount, candidateSet.chapters.length, 1);
  const realRemoveRatio = trueRemoves / denominator;
  const major =
    realRemoveRatio > ENGINE_CONFIG.updateEngine.majorRebuildRemoveRatio ||
    trueRemoves >= MAX_PLAN_ITEMS;
  const ratioPct = Math.round(realRemoveRatio * 100);
  return {
    strategy: major ? 'MAJOR_VERSION_REBUILD' : 'INCREMENTAL_PATCH',
    trueRemoves,
    realRemoveRatio,
    totalChapters: denominator,
    reason: major
      ? `真实删除率 ${ratioPct}%（${trueRemoves}/${denominator} 章）超阈值，转大版本冷重建`
      : `真实删除率 ${ratioPct}%（${trueRemoves}/${denominator} 章），增量补丁`,
  };
}

export function validatePlan(plan: UpdatePlan, candidateSet: UpdateCandidateSet): void {
  if (plan.chapters.length > MAX_PLAN_ITEMS) {
    throw new UpdatePlanValidationError(
      `更新计划章节数 ${plan.chapters.length} 超过上限 ${MAX_PLAN_ITEMS}，建议走强制全量重新导入`
    );
  }

  const allowedPaths = new Set(candidateSet.chapters.map((c) => c.path));
  const allowedAddPaths = new Set(
    candidateSet.unmatchedFiles.filter((f) => f.change === 'added').map((f) => f.path)
  );
  for (const c of candidateSet.structuralAdds) allowedAddPaths.add(c.path);
  for (const ch of plan.chapters) {
    if (ch.action === 'add') {
      if (!allowedPaths.has(ch.path) && !allowedAddPaths.has(ch.path)) {
        throw new UpdatePlanValidationError(`add 目标 ${ch.path} 不在候选集内（越权）`);
      }
    } else if (!allowedPaths.has(ch.path)) {
      throw new UpdatePlanValidationError(`${ch.action} 目标 ${ch.path} 不在候选集内（越权）`);
    }
  }
}

function buildDocUrl(path: string, owner: string, repo: string): string {
  return `/docs/${owner}/${repo}/${path.replace(/\.(md|mdx)$/i, '')}`;
}

function buildAddNode(ch: { path: string; title?: string; position?: string }, owner: string, repo: string): { node: NavNode; finalPath: string; positionPath?: string } {
  const base = ch.path.split('/').pop()?.replace(/\.(md|mdx)$/i, '') || ch.path;
  return {
    node: {
      name: base,
      title: ch.title ?? base,
      type: 'file',
      path: ch.path,
      url: buildDocUrl(ch.path, owner, repo),
    },
    finalPath: ch.path,
    positionPath: ch.position,
  };
}

function buildCodeAddNode(ch: { title?: string; position?: string }, order: number, owner: string, repo: string): { node: NavNode; finalPath: string; positionPath?: string } {
  const finalPath = codeChapterPath(order);
  const name = `chapter-${order}`;
  return {
    node: {
      name,
      title: ch.title ?? name,
      type: 'file',
      path: finalPath,
      url: `/docs/${owner}/${repo}/${name}`,
    },
    finalPath,
    positionPath: ch.position,
  };
}

export async function applyUpdatePlan(params: ApplyUpdatePlanParams): Promise<ApplyUpdateResult> {
  const { repositoryId, userId, docOwnerId, fromSha, toSha, plan: rawPlan, candidateSet, runId } = params;

  const { plan, coerced } = coercePlanDraft(rawPlan, candidateSet);
  validatePlan(plan, candidateSet);

  try {
    const sidecarResult = await executeSidecarUpdateApply({
      ...params,
      plan: rawPlan,
    });
    return {
      ...sidecarResult,
      coercedActions: Math.max(sidecarResult.coercedActions, coerced.length),
    };
  } catch (err) {
    console.warn('[UpdateApplier] Sidecar update apply failed or unavailable, falling back to local Prisma transaction:', err);
  }

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { owner: true, repo: true, branch: true, gitSha: true, navTree: true, repoProfile: true },
  });
  if (!repo) throw new Error(`Repository ${repositoryId} not found`);
  // Only the first canonical updater (docOwnerId=null) advances navTree/gitSha; private updaters must not mutate shared state.
  const needStructural = docOwnerId === null && repo.gitSha !== toSha;

  const repoProfile = (repo.repoProfile as Record<string, unknown> | null) ?? {};
  const oldClusters =
    (repoProfile[REPO_PROFILE_CLUSTERS_KEY] as Array<{ teachingOrder: number; chapterNo?: number; title: string; files: string[] }>) ?? [];
  let nextCodeOrder = oldClusters.reduce((max, c) => Math.max(max, c.chapterNo ?? c.teachingOrder), 0) + 1;

  let pendingOutlineDraft: ReturnType<typeof outlineFromNavTree> | null = null;
  const result = await prisma.$transaction(
    async (tx) => {
      const renameFacts = candidateSet.chapters.flatMap((c) => (c.rename ? [c.rename] : []));
      const adds: Array<{ node: NavNode; finalPath: string; positionPath?: string }> = [];
      const docCreates: Array<{ path: string; title: string; content: string; status: string }> = [];
      const docUpdates: string[] = [];
      const docRemoves: string[] = [];

      for (const ch of plan.chapters) {
        if (ch.action === 'update') {
          docUpdates.push(ch.path);
        } else if (ch.action === 'remove') {
          docRemoves.push(ch.path);
        } else if (ch.action === 'add') {
          const built = isCodeChapterPath(ch.path)
            ? buildCodeAddNode(ch, nextCodeOrder, repo.owner, repo.repo)
            : buildAddNode(ch, repo.owner, repo.repo);
          nextCodeOrder += isCodeChapterPath(ch.path) ? 1 : 0;
          adds.push(built);
          docCreates.push({
            path: built.finalPath,
            title: built.node.title,
            content: '',
            status: DocumentStatus.UNPROCESSED,
          });
        }
      }

      const mutationRes = await callSidecar<{
        ok: boolean;
        renamed: number;
        updated: number;
        removed: number;
        created: number;
        appliedRenames?: Array<{ from: string; to: string }>;
      }>(
        '/v1/documents/mutation',
        {
          repositoryId,
          ownerUserId: docOwnerId,
          renames: renameFacts,
          updates: docUpdates,
          removes: docRemoves,
          creates: docCreates,
        },
        { label: 'update-applier-doc-mutation' }
      );

      const renamedDocs = mutationRes.renamed ?? 0;
      const appliedRenames = mutationRes.appliedRenames ?? [];
      const updatedDocs = mutationRes.updated ?? 0;
      const removedDocs = mutationRes.removed ?? 0;

      let navTreePatched = false;
      let gitShaAdvanced = false;
      if (needStructural) {
        const remove = plan.chapters.filter((c) => c.action === 'remove').map((c) => c.path);
        const patch: NavTreePatch = {
          remove,
          add: adds.map((a) => ({ node: a.node, positionPath: a.positionPath })),
          rename: appliedRenames.map((r) => ({
            from: r.from,
            to: r.to,
            toUrl: buildDocUrl(r.to, repo.owner, repo.repo),
          })),
        };
        const currentTree = await getEffectiveNavTree(repositoryId, {
          owner: repo.owner,
          repo: repo.repo,
          tx,
          fallbackNavTree: repo.navTree,
        });
        const newTree = patchNavTree(currentTree, patch);

        let newClusters = oldClusters;
        if (oldClusters.length > 0) {
          newClusters = oldClusters
            .filter((c) => !remove.includes(codeChapterPath(clusterChapterNo(c))))
            .map((c) => c);
          adds
            .filter((a) => isCodeChapterPath(a.finalPath))
            .forEach((a) => {
              const order = Number(a.finalPath.split('/').pop()?.replace('.mdx', ''));
              newClusters = [
                ...newClusters,
                { teachingOrder: order, chapterNo: order, title: a.node.title, files: [] },
              ];
            });
        }

        await callSidecar(
          '/v1/repos/patch',
          {
            id: repositoryId,
            gitSha: toSha,
            hasUpstreamUpdate: false,
            ...(newClusters !== oldClusters
              ? { repoProfile: { ...repoProfile, [REPO_PROFILE_CLUSTERS_KEY]: newClusters } }
              : {}),
          },
          { label: 'update-applier-repo-patch' }
        );

        pendingOutlineDraft = outlineFromNavTree(newTree);

        navTreePatched = true;
        gitShaAdvanced = true;
      }

      await registerImportSnapshot(tx, {
        userId,
        repositoryId,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch,
        sha: toSha,
        prefix: null,
        docOwnerId,
        skipDocumentReset: true,
      });

      if (runId) {
        await callSidecar(
          '/v1/update/runs/status',
          {
            id: runId,
            status: 'APPLIED',
            stats: {
              docsToUpdate: updatedDocs,
              docsToRemove: removedDocs,
              docsToAdd: adds.length,
              docsToRename: renamedDocs,
              coercedActions: coerced.length,
              navTreePatched,
              gitShaAdvanced,
            },
          },
          { label: 'update-runs-status-applied' }
        ).catch((err) => {
          // Re-throw on status failure: leaving run stuck in APPLYING causes permanent 409 locks.
          void import('@/lib/observability/errors').then((m) =>
            m.captureError(err, {
              scope: 'update-applier/status-applied',
              extra: { runId, updatedDocs, removedDocs },
            })
          );
          throw err;
        });
      }

      return {
        updatedDocs,
        removedDocs,
        addedDocs: adds.length,
        renamedDocs,
        coercedActions: coerced.length,
        navTreePatched,
        gitShaAdvanced,
      };
    },
    { timeout: 60000 }
  );

  // Activate outline outside the DB transaction to avoid lock contention; failures deactivate stale outlines for read-side self-heal rather than failing committed updates.
  if (pendingOutlineDraft) {
    try {
      await storeOutlineDraft(repositoryId, pendingOutlineDraft, { isActive: true });
    } catch (firstErr) {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(firstErr, {
          scope: 'update-applier/outline-store-retry',
          extra: { repositoryId },
        })
      );
      try {
        await storeOutlineDraft(repositoryId, pendingOutlineDraft, { isActive: true });
      } catch (retryErr) {
        try {
          await deactivateAllOutlines(repositoryId);
          console.error(
            '[update-applier] outline store failed twice, stale outline deactivated for read-side self-heal:',
            { repositoryId, retryErr }
          );
        } catch (deactivateErr) {
          console.error(
            '[update-applier] CRITICAL: outline store + deactivate both failed; outline stays stale until admin reoutline:',
            { repositoryId, retryErr, deactivateErr }
          );
        }
      }
    }
  }

  return result;
}
