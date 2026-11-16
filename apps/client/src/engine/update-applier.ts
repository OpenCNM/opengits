/**
 * 更新计划确定性执行器（plan-then-apply Stage 2）。
 *
 * 职责：把 LLM 计划草案映射为原子数据库操作。LLM 全程不触碰数据——
 * 本模块是唯一的写入口，所有操作经事务 + 归属维度（ownerUserId）限定。
 *
 * 代码接管（草案不直接执行，先矫正再路由）：
 * - coercePlanDraft：rename 章节的 LLM 裁决一律忽略（代码迁移路径）；
 *   remove 逐条用 Git 事实核验，源文件未全部消失的"幻觉删除"矫正为 update
 * - decideExecutionStrategy：真实删除率超阈值 → MAJOR_VERSION_REBUILD
 *   （调用方转大版本流：快照归档 + ImportJob 全量冷重建），不再中断报错
 * - rename 迁移：diffArchives 哈希配对（内容未变）→ 事务内改写 Document.path
 *   + navTree 节点 path/url，绝不重转录
 *
 * 语义（与矫正后计划一致）：
 * - update → 重置该用户文档（content=null, UNPROCESSED, gitSha=null），重新转录
 * - keep   → 不动
 * - remove → 删除该用户文档（+ navTree 摘除，仅当本用户是首个更新者）
 * - add    → 创建新文档（UNPROCESSED）+ navTree 定点插入（不重排）
 *
 * navTree 两种情况（关键语义，结构副作用绑定归属）：
 * - 本用户更新共享正典（docOwnerId=null）且 Repository.gitSha != toSha（首个正典更新者）
 *   → patch navTree + 推进 gitSha + 清红点。这三者代表"公共副本已同步"，必须由真正
 *   写共享行的人触发；私有副本更新者只同步自己的行，绝不冒充公共同步——否则共享行
 *   还停在旧版时红点已消、navTree 已换新，读者被静默晾在旧内容上。
 * - 其余情况（正典已是 toSha / 私有副本更新）→ 只同步归属者的文档副本
 *
 * 校验层（守卫）：action 目标必须在候选集内（越权直接抛错回滚）；章节数上限保护。
 */

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

/** 单次更新计划章节数上限（超过说明 LLM 失控/仓库剧变，拒绝并提示全量重导） */
export const MAX_PLAN_ITEMS = 50;

export interface ApplyUpdatePlanParams {
  repositoryId: string;
  userId: string;
  docOwnerId: string | null;
  fromSha: string;
  toSha: string;
  plan: UpdatePlan;
  candidateSet: UpdateCandidateSet;
  /** ImportUpdateRun 记录 id（状态流转 + 审计） */
  runId?: string;
}

export interface ApplyUpdateResult {
  updatedDocs: number;
  removedDocs: number;
  addedDocs: number;
  /** rename 路径迁移完成的文档数（内容保留，未重转录） */
  renamedDocs: number;
  /** 被代码矫正的 LLM 草案条目数（rename 接管 + 幻觉 remove 矫正） */
  coercedActions: number;
  navTreePatched: boolean;
  gitShaAdvanced: boolean;
}

type UpdateExecutionStrategy = 'INCREMENTAL_PATCH' | 'MAJOR_VERSION_REBUILD';

interface StrategyDecision {
  strategy: UpdateExecutionStrategy;
  /** Git 事实核验后的合法 remove 数（rename 伪删除/幻觉删除均不计入） */
  trueRemoves: number;
  /** trueRemoves ÷ max(归属全部现存章节数, 候选章节数, 1) */
  realRemoveRatio: number;
  /** 分母（审计用） */
  totalChapters: number;
  reason: string;
}

interface CoercedAction {
  path: string;
  fromAction: UpdateActionKind;
  /** 'DROP' = 条目被整条剔除（rename 接管） */
  toAction: UpdateActionKind | 'DROP';
  reason: string;
}

interface CoercePlanResult {
  plan: UpdatePlan;
  coerced: CoercedAction[];
}

export class UpdatePlanValidationError extends Error {}

/**
 * Git 事实核验：remove 是否对应"源文件在上游真的全部消失"。
 * - rename 命中 → 永远不是真删除（伪删除，代码迁移路径）
 * - 重聚类判定的消失模块（structuralRemoves）→ 真删除
 * - 其余：章节的受影响文件非空且全部为 removed → 真删除
 */
function isGitTrueRemove(path: string, candidateSet: UpdateCandidateSet): boolean {
  const cand = candidateSet.chapters.find((c) => c.path === path);
  if (!cand) return false;
  if (cand.rename) return false;
  if (candidateSet.structuralRemoves.some((c) => c.path === path)) return true;
  return cand.affectedFiles.length > 0 && cand.affectedFiles.every((f) => f.change === 'removed');
}

/**
 * 草案矫正（事务前纯函数，可单测）：LLM 输出是"不可信草案"——
 * 1. rename 章节的任何裁决整条剔除（执行器按候选集 rename 事实确定性迁移）；
 * 2. remove 无 Git 事实支撑（源文件未全部消失）→ 幻觉删除，矫正为 update（宁多勿少），
 *    不中断整个计划——残余错误影响被限制到"多转录一章"的保守代价。
 */
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

/**
 * 执行策略路由（纯函数，可单测）：真实删除率超阈值或合法删除规模爆表
 * → 大版本冷重建，否则增量补丁。调用方在应用前决策——增量走 applyUpdatePlan，
 * 大版本走「快照归档 + ImportJob 全量重建」，不再抛 REMOVE_RATIO_EXCEEDED 中断。
 */
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

/**
 * 校验计划（事务外快速失败）：越权目标 / 章节数超限 / add 目标合法性。
 * add 的目标必须是候选集的 added 未命中文件（新模块）或候选章节路径。
 * 删除率路由不在此处：超阈值删除由 decideExecutionStrategy 转大版本流，不再中断。
 */
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
  // M2b 重聚类产出的新模块章节候选：add 目标同样放行
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

/** 文档章节站点 URL（navTree 节点与 rename 迁移共用的唯一构造口径） */
function buildDocUrl(path: string, owner: string, repo: string): string {
  return `/docs/${owner}/${repo}/${path.replace(/\.(md|mdx)$/i, '')}`;
}

/** add 章节的 navTree 节点构造（文档章节按真实路径；代码章节走 buildCodeAddNode） */
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

/**
 * 应用更新计划（单事务，60s timeout）。
 * 失败抛错（事务回滚），调用方负责置 ImportUpdateRun.status = FAILED。
 */
export async function applyUpdatePlan(params: ApplyUpdatePlanParams): Promise<ApplyUpdateResult> {
  const { repositoryId, userId, docOwnerId, fromSha, toSha, plan: rawPlan, candidateSet, runId } = params;

  // ── 0. 草案矫正（幂等：调用方可能已矫正过）：LLM 裁决不直接执行 ──
  const { plan, coerced } = coercePlanDraft(rawPlan, candidateSet);
  validatePlan(plan, candidateSet);

  // ── 1. 优先调用 Go worker-sidecar 原生 pgx 直写（毫秒级原子事务，解耦连接池）──
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

  // ── 2. 本地 Prisma 事务降级执行（Fail-Open 兜底）──
  // ── 仓库现状（决定 navTree 是否需要 patch）──
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { owner: true, repo: true, branch: true, gitSha: true, navTree: true, repoProfile: true },
  });
  if (!repo) throw new Error(`Repository ${repositoryId} not found`);
  // 结构副作用绑定归属：仅共享正典更新（docOwnerId=null）才允许推进公共基线；
  // 私有副本更新者跳过 navTree/gitSha/红点，只同步自己的文档行
  const needStructural = docOwnerId === null && repo.gitSha !== toSha;

  const repoProfile = (repo.repoProfile as Record<string, unknown> | null) ?? {};
  const oldClusters =
    (repoProfile[REPO_PROFILE_CLUSTERS_KEY] as Array<{ teachingOrder: number; chapterNo?: number; title: string; files: string[] }>) ?? [];
  let nextCodeOrder = oldClusters.reduce((max, c) => Math.max(max, c.chapterNo ?? c.teachingOrder), 0) + 1;

  let pendingOutlineDraft: ReturnType<typeof outlineFromNavTree> | null = null;
  const result = await prisma.$transaction(
    async (tx) => {
      // ── 1. rename 迁移（代码接管，先于计划执行）：diffArchives 哈希配对 = 内容未变，
      // 只改写 Document.path，绝不重转录；目标路径已被同归属占用（唯一约束冲突）→
      // 该条降级跳过并告警，不影响其余迁移。 ──
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
        // keep → 不动
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

      // ── 3. navTree patch（仅情况 2：本用户是首个更新者）──
      let navTreePatched = false;
      let gitShaAdvanced = false;
      if (needStructural) {
        const remove = plan.chapters.filter((c) => c.action === 'remove').map((c) => c.path);
        const patch: NavTreePatch = {
          remove,
          add: adds.map((a) => ({ node: a.node, positionPath: a.positionPath })),
          // rename 原地改写节点 path/url（不增删、不重排，标题保持——内容未变标题未变）
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

        // codeClusters 快照同步（代码章节 add/remove）
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

        // ── 大纲彻底去物化：以 newTree 确定性派生并激活 V2 TutorialOutline ──
        // 增量更新导致结构变更后，记录待落库大纲；在外部事务提交后激活，消解事务逃逸与死锁风险
        pendingOutlineDraft = outlineFromNavTree(newTree);

        navTreePatched = true;
        gitShaAdvanced = true;
      }

      // ── 4. 快照推进：ImportRecord → UPDATED（skipDocumentReset：文档已按计划精确处理）──
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

      // ── 5. 运行记录状态（通过 Go worker-sidecar 单写者）──
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
          // 不再静默：apply 事务已提交而 run 状态写失败时，run 卡在
          // APPLYING（认领后不可再 claim）→ 用户永久 409。留痕 + 上抛，
          // 由调用方展示（实际数据已落库，人工把 run 置 APPLIED 即恢复）
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

  // 事务成功提交后落库激活大纲（单一写者，解绑事务逃逸）。
  // 快照/gitSha/文档事实已原子提交，大纲只是 newTree 的确定性投影——落库失败
  // 绝不上抛假错：调用方会误判整个增量更新失败，且 gitSha 已推进导致重试永远
  // 不会重新触发大纲派生。补偿链（每级留痕）：
  //   1) 短重试一次（sidecar 瞬时抖动）；
  //   2) 仍失败 → 下架旧结构激活大纲，读侧 resolveEffectiveNavTree 的自愈路径
  //      将从已提交的 Document 事实确定性重建（navTree 已停写，新仓为 null 直达；
  //      legacy 仓回退旧 navTree，等价于旧大纲的旧结构，不劣化）；
  //   3) 下架也失败（sidecar 硬宕）→ CRITICAL 留痕 repositoryId，交由运维重排/admin reoutline。
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
