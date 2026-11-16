// 章节级更新市场引擎 v1（状态机与业务规则的单一事实源）。
//
// 核心语义（机检即入库）：上游变更/开荒 → 认领转录 → 机器门（L0 / 契约三件套）
// → 通过即直换入库为 ChapterVersion 正典版本。读者在正文详情页通过
// ChapterVersionSwitcher 自由切换版本并点赞（一人一版一票 toggle）。
// 旧的「试读与表决」（TRIAL 状态机、新旧对比、AI 参谋、集中投票）已退役：
// 不再产生新 TRIAL 任务，存量 TRIAL 由 Go 侧 sweep 按超时默认换入排水收敛。
// 任何失败态读者看到的都是上一版——最坏情况是"没更新"，不是"坏更新"。
//
// 贡献者使用自有 API Key 转录。转录奖励已退役：不发钱包积分、不增加身价；历史奖励记录保留。
// 2026-11 外围清理：退役兼容面（estimateChapterUpdateCredits / giftOf /
// capDailyEarn / resolveTimeouts）彻底拆除——清扫与存量 TRIAL 排水收敛为
// Go sidecar 单写者（orphan-sweeper 60s 互斥 + auto-update runner 周期直调）。

import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import {
  CHAPTER_UPDATE_JOB_STATUS as S,
  CHAPTER_UPDATE_JOB_KIND as K,
} from '@/lib/schemas/update-job';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';
import { l0Gate } from './gate';
import { NOTIFICATION_TYPES } from '@/lib/schemas/notification';

export { l0Gate };

const MARKET = ENGINE_CONFIG.updateMarket;

/**
 * 更新市场暂存转录：委托 Go staged 无锁变体（/v1/transcription/staged-generate）。
 * 零文档写入——产物交调用方暂存（DocumentContent 新行 + 试读投票），换入由
 * 市场引擎的事务完成。onProgress 在跨进程同步调用下不可传输（L0 门禁只消费终稿）。
 */
async function generateStagedContent(
  docId: string,
  opts: { userId?: string | null; model?: string; sourceSha: string }
): Promise<{ content: string; model: string }> {
  return callSidecar<{ content: string; model: string }>(
    '/v1/transcription/staged-generate',
    {
      documentId: docId,
      userId: opts.userId ?? undefined,
      model: opts.model,
      sourceSha: opts.sourceSha,
    },
    // 全链 LLM 管线（长文分块/代码章装甲闭环）分钟级耗时，配长超时
    { label: 'transcription-staged-generate', timeoutMs: 15 * 60_000 }
  );
}

/**
 * 市场接力转录（RELAY 首译开荒）：委托 Go staged-relay 无锁变体
 * （/v1/transcription/staged-relay，2026-10 下沉）。契约三件套（信封/结构化
 * schema/确定性编译+L0-R 对源硬门）全链闭环于 Go；认领者 BYOK 经网关
 * keyOrigin=user 解析——与原 Node generateStructured 直连语义等价。
 */
export async function generateRelayStagedContent(
  docId: string,
  opts: { userId?: string | null; model?: string; sourceSha: string }
): Promise<{ mdx: string; model: string }> {
  return callSidecar<{ mdx: string; model: string }>(
    '/v1/transcription/staged-relay',
    {
      documentId: docId,
      userId: opts.userId ?? undefined,
      model: opts.model,
      sourceSha: opts.sourceSha,
    },
    { label: 'transcription-staged-relay', timeoutMs: 15 * 60_000 }
  );
}

export class UpdateMarketError extends Error {
  constructor(
    message: string,
    public code:
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'ALREADY_CLAIMED'
      | 'EMERGENCY_READONLY'
  ) {
    super(message);
  }
}

function mapSidecarError(err: unknown): never {
  if (err instanceof UpdateMarketError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ALREADY_CLAIMED')) {
    throw new UpdateMarketError('已被他人认领', 'ALREADY_CLAIMED');
  }
  if (msg.includes('NOT_FOUND')) {
    throw new UpdateMarketError('任务或章节不存在', 'NOT_FOUND');
  }
  if (msg.includes('INVALID_STATE') || msg.includes('409')) {
    throw new UpdateMarketError('任务状态已变化或不在可操作状态', 'INVALID_STATE');
  }
  throw err;
}

/**
 * 建立过期章节任务（调度器每轮调用；幂等——由 Go 侧单事务原子判定与记账）。
 * 结构变更（added/removed 命中候选）不进市场：留给维护者手动 plan→apply。
 */
export async function createStaleJobs(
  repo: { id: string; gitSha: string | null },
  candidateSet: UpdateCandidateSet,
  toSha: string
): Promise<{ created: number; structural: boolean }> {
  if (candidateSet.chapters.some((c) => c.change === 'structural')) {
    return { created: 0, structural: true };
  }
  // 物理拦截 keepExemption 豁免章节：由 Go 语义证明无需更新，彻底杜绝白噪音建单与缓存击穿
  const contentPaths = candidateSet.chapters
    .filter((c) => !c.keepExemption)
    .map((c) => c.path);
  if (contentPaths.length === 0) return { created: 0, structural: false };

  const { executeSidecarMarketJobCreateStale } = await import('@/engine/market-driver');
  return await executeSidecarMarketJobCreateStale({
    repositoryId: repo.id,
    fromSha: repo.gitSha ?? '',
    toSha,
    paths: contentPaths,
  });
}

/**
 * 按需为单章节建立/获取 RELAY 任务（按需点译的唯一建单入口：由 Go 侧 advisory lock 原子串行化）。
 */
export async function ensureRelayJobForDocument(documentId: string): Promise<{ id: string; repositoryId: string; kind: string; status: string }> {
  if (await isEmergencyReadOnly()) {
    throw new UpdateMarketError('全站维护中，任务认领暂停', 'EMERGENCY_READONLY');
  }
  try {
    const { executeSidecarMarketJobEnsureRelay } = await import('@/engine/market-driver');
    return await executeSidecarMarketJobEnsureRelay(documentId);
  } catch (err) {
    mapSidecarError(err);
  }
}

/** 认领（CAS：PENDING 且无有效租约 → CLAIMED；Go 侧原子更新） */
export async function claimJob(
  jobId: string,
  userId: string
): Promise<{ frozenCredits: number }> {
  if (await isEmergencyReadOnly()) {
    throw new UpdateMarketError('全站维护中，任务认领暂停', 'EMERGENCY_READONLY');
  }
  try {
    const { executeSidecarMarketJobClaim } = await import('@/engine/market-driver');
    const res = await executeSidecarMarketJobClaim(jobId, userId, MARKET.claimTtlMin);
    return res;
  } catch (err) {
    mapSidecarError(err);
  }
}

/** 主动放弃认领（CAS：仅仍处于 CLAIMED 且归本人认领的任务可释放回 PENDING） */
export async function abandonClaim(
  jobId: string,
  userId: string
): Promise<void> {
  try {
    const { executeSidecarMarketJobRelease } = await import('@/engine/market-driver');
    await executeSidecarMarketJobRelease(jobId, userId);
  } catch (err) {
    mapSidecarError(err);
  }
}

/**
 * 接力章节换入通知（向 autoFollow 跟随者推送）：
 * 1. 1 小时窗口防抖：过滤掉 1 小时内收到过该仓更新通知的用户，防止多章并发接力刷屏；
 * 2. 检查全书是否全部完工（unprocessedCount === 0）：
 *    - 若 100% 完工：向全体跟随者推送 TUTORIAL_PUBLISHED 里程碑完结通知；
 *    - 否则：推送 AUTO_SYNC_APPLIED 进度通知（章节接力更新已自动同步至个人项目）。
 */
export async function notifyRelaySettled(
  job: { repositoryId: string; documentId: string; path: string; claimedBy: string },
  repo: { owner: string; repo: string }
): Promise<void> {
  try {
    const followers = await prisma.savedRepo.findMany({
      where: { repositoryId: job.repositoryId, autoFollow: true },
      select: { userId: true },
    });
    // 转录者本人刚亲手转录，无需通知自己
    const candidateIds = [...new Set(followers.map((f) => f.userId).filter((id) => id !== job.claimedBy))];
    if (candidateIds.length === 0) return;

    // 1 小时窗口防抖：过滤掉最近 1 小时内已收到过该仓库更新通知的用户
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentNotifs = await prisma.notification.findMany({
      where: {
        userId: { in: candidateIds },
        type: { in: [NOTIFICATION_TYPES.AUTO_SYNC_APPLIED, NOTIFICATION_TYPES.RELAY_OPEN, NOTIFICATION_TYPES.TUTORIAL_PUBLISHED] },
        createdAt: { gte: oneHourAgo },
      },
      select: { userId: true, payload: true },
    });
    const throttledUserIds = new Set(
      recentNotifs
        .filter((n) => {
          let p = n.payload as Record<string, unknown> | null;
          if (typeof p === 'string') {
            try {
              p = JSON.parse(p) as Record<string, unknown>;
            } catch {
              return false;
            }
          }
          return Boolean(p && typeof p === 'object' && p.owner === repo.owner && p.repo === repo.repo);
        })
        .map((n) => n.userId)
    );
    const recipientIds = candidateIds.filter((id) => !throttledUserIds.has(id));
    if (recipientIds.length === 0) return;

    // 查询该仓剩余未处理章节数
    const remainingUnprocessed = await prisma.document.count({
      where: { repositoryId: job.repositoryId, ownerUserId: null, status: 'UNPROCESSED' },
    });

    const isFullyCompleted = remainingUnprocessed === 0;

    const { sendNotifications } = await import('@/lib/notifications/notification-sender');
    if (isFullyCompleted) {
      await sendNotifications(
        recipientIds.map((userId) => ({
          userId,
          type: NOTIFICATION_TYPES.TUTORIAL_PUBLISHED,
          title: `🎉 ${repo.owner}/${repo.repo} 全书接力完结`,
          body: `教程所有章节已由社区全部转录完工！已同步至您的个人项目，欢迎完整阅读。`,
          payload: { owner: repo.owner, repo: repo.repo, path: job.path, completed: true },
        }))
      );
    } else {
      await sendNotifications(
        recipientIds.map((userId) => ({
          userId,
          type: NOTIFICATION_TYPES.AUTO_SYNC_APPLIED,
          title: `${repo.owner}/${repo.repo} 新接力章节已就绪`,
          body: `${job.path} 已由社区志愿者完成转录并换入正典，已自动同步至您的个人项目。`,
          payload: { owner: repo.owner, repo: repo.repo, path: job.path },
        }))
      );
    }
  } catch (err) {
    void import('@/lib/observability/errors').then((m) =>
      m.captureError(err, { scope: 'update-market/notify-relay-settled', extra: { documentId: job.documentId } })
    );
  }
}

/**
 * 认领者的转录：生成（零文档写入）→ 机器门 → 直换入库（ChapterVersion 正典版本）。
 * RELAY 走契约管线（三件套 + L0-R 对源硬门），UPDATE 走 staged 管线 + L0 门禁；
 * 过门即上架——无试读投票，读者在正文详情页切换版本并点赞。
 * 生成失败 / 门禁拒绝 → FAILED（积分隐式退还）。
 */
export async function runStagedTranscription(jobId: string): Promise<{ baseCredits: number }> {
  const job = await prisma.chapterUpdateJob.findUnique({
    where: { id: jobId },
    include: {
      document: { select: { content: true, path: true, contentRef: { select: { content: true } } } },
      repository: { select: { id: true, owner: true, repo: true, gitSha: true, repoProfile: true } },
    },
  });
  if (!job) throw new UpdateMarketError('任务不存在', 'NOT_FOUND');
  if (job.status !== S.CLAIMED || !job.claimedBy) {
    throw new UpdateMarketError('任务未处于已认领状态', 'INVALID_STATE');
  }
  // 守卫后捕获（闭包内使用，TS 不跨函数边界收窄对象属性）
  const claimedBy: string = job.claimedBy;
  if (job.claimedUntil && job.claimedUntil < new Date()) {
    throw new UpdateMarketError('认领已超时，任务已回池', 'INVALID_STATE');
  }

  const targetSha = (job.toSha?.trim() || job.fromSha?.trim() || job.repository?.gitSha?.trim()) ?? '';
  if (!targetSha) {
    throw new UpdateMarketError('任务缺少代码版本 (SHA)', 'INVALID_STATE');
  }

  // 确保归档在本地就绪（防止归档未下载或已被清理导致转录时源码直读为空）
  if (/^[0-9a-f]{7,40}$/i.test(targetSha)) {
    try {
      const { ensureArchive } = await import('@/engine/repo-tarball');
      await ensureArchive(job.repository.owner, job.repository.repo, targetSha);
    } catch {
      // 归档拉取失败不强行阻断（脱机单测或 mock 环境）；后续 Go 侧在物理读取时做权威校验
    }
  }

  try {
    // ── 生成 + 机器门（kind 只决定生成管线，过门后同一条直换收敛尾）──
    let content: string;
    let model: string;
    if (job.kind === K.RELAY) {
      // RELAY（首译开荒）：Go staged-relay 契约管线（三件套闭环：信封 purpose/
      // 结构化 schema 校验/确定性编译+L0-R 对源硬门镜像）。2026-10 下沉：
      // Node BYOK 直连管线退役，与 UPDATE 分支同为 Go 薄封装——市场两条生成
      // 路径口径归一。
      const relay = await generateRelayStagedContent(job.documentId, {
        userId: claimedBy,
        sourceSha: targetSha,
      });
      content = relay.mdx;
      model = relay.model;
    } else {
      // UPDATE（上游变更重译）：Go staged 无锁变体 + L0 门禁（与在役旧版比对）。
      // 生成能力单一事实源在 Go（术语台账/架构骨架/源码插槽与队列路径同享）；
      // 2026-10 收口：Node 暂存管线随同步执行器双轨退役，此处为薄封装。
      const staged = await generateStagedContent(job.documentId, {
        userId: claimedBy,
        sourceSha: targetSha,
      });
      if (!staged.content || staged.content.trim() === '') {
        throw new Error('生成的章节内容为空');
      }
      const gate = l0Gate(staged.content, job.document.contentRef?.content ?? job.document.content);
      if (!gate.passed) {
        throw new Error(`L0 门禁未过：${gate.reason}`);
      }
      content = staged.content;
      model = staged.model;
    }

    const { upsertContentLayer, computeContentHash, computeRequestFingerprint, isDualWriteEnabled } = await import('@/lib/content-addressing');
    const { fingerprintInputsFor } = await import('@/lib/transcription/fingerprint');
    const { toProfileRecord } = await import('@/lib/transcription/types');
    // 指纹与 Go prepare 同解析链（缺省由 repoProfile 兜底 + preset 默认展开）：
    // 市场成品因此可被后续 prepare 的 FindReusableContentByFingerprint 命中复用。
    // gitSha 用 targetSha（内容实际生成的代码版本），非仓库行现值。
    const fingerprint = computeRequestFingerprint(
      fingerprintInputsFor(
        {
          repositoryId: job.repositoryId,
          path: job.path,
          repository: { gitSha: targetSha, repoProfile: toProfileRecord(job.repository?.repoProfile) },
        },
        model,
        {},
      ),
    );
    const contentId = await upsertContentLayer({
      contentHash: computeContentHash(content, ''),
      requestFingerprint: fingerprint,
      content,
      lang: '',
      generationModel: model,
    });

    // 机检即入库：直换事务（CAS CLAIMED→SWAPPED + 文档晋升 + ChapterVersion 正典版本）。
    // 转录发酬已全面退役：不估算、不发钱包积分。由 Go sidecar 原子执行换入与版本清位；
    // 正文不直传——sidecar 事务内按 stagedContentId 从内容寻址层读取（与 TRIAL 排水同源）
    const { executeSidecarMarketJobRelaySettle } = await import('@/engine/market-driver');
    await executeSidecarMarketJobRelaySettle({
      jobId: job.id,
      userId: claimedBy,
      documentId: job.documentId,
      repositoryId: job.repositoryId,
      stagedContentId: contentId,
      stagedModel: model,
      toSha: targetSha,
      dualWrite: isDualWriteEnabled(),
    });

    // 事后增强（图谱+审计）复用换入链；失败不阻断上架结果
    void postSwap(
      { repositoryId: job.repositoryId, documentId: job.documentId, path: job.path, stagedContentId: contentId },
      content
    ).catch((e) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(e, { scope: 'update-market/relay-post-swap', extra: { jobId: job.id } })
      );
    });

    // 社区接力换入通知：向 autoFollow 跟随者防抖推送
    void notifyRelaySettled(
      { repositoryId: job.repositoryId, documentId: job.documentId, path: job.path, claimedBy },
      { owner: job.repository.owner, repo: job.repository.repo }
    ).catch((e) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(e, { scope: 'update-market/relay-notify-settled', extra: { jobId: job.id } })
      );
    });

    return { baseCredits: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { executeSidecarMarketJobMarkFailed } = await import('@/engine/market-driver');
    await executeSidecarMarketJobMarkFailed(job.id, claimedBy, message).catch((writeErr) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(writeErr, { scope: 'update-market/failed-write', extra: { jobId: job.id } })
      );
    });
    mapSidecarError(err);
  }
}

/** 事后增强（图谱+审计链）。versions.ts 夺位翻正后的重索引共用 */
export async function postSwap(
  job: { repositoryId: string; documentId: string; path: string; stagedContentId: string | null },
  content: string
): Promise<void> {
  // 双写不变量：legacy chunk 换血 + 概念/边重建（与 finalizeDocument 同链）
  if (content) {
    const { syncDocumentKnowledgeGraph } = await import('@/lib/mcp/document-graph-sync');
    await syncDocumentKnowledgeGraph(job.repositoryId, job.documentId, job.path, content);
  }

  // 绝对底线 re-audit：每 N 次换入跑一次零 LLM 管线分，跌破底线置 qualityHold
  const res = await callSidecar<{ ok: boolean; autoSwapCount?: number }>(
    '/v1/repos/increment',
    {
      id: job.repositoryId,
      autoSwapCount: 1,
    },
    { label: 'update-market-increment-swap-count' }
  );
  const autoSwapCount = res?.autoSwapCount ?? 0;
  if (autoSwapCount > 0 && autoSwapCount % MARKET.auditEveryNSwaps === 0) {
    try {
      // AST 口径复检下沉 Go（散文里的 retry/import 不再计分；与 sweep 路径
      // 收敛同一 PipelineScoreTotalAST 单一口径，正文读内容寻址层）
      const audit = await callSidecar<{ ok: boolean; score: number; floor: number; held: boolean }>(
        '/v1/market/repo-audit',
        { repositoryId: job.repositoryId },
        { label: 'update-market-repo-audit' }
      );
      if (audit.held) {
        console.warn(`[update-market] quality hold: pipeline ${audit.score} < floor ${audit.floor}`);
      }
    } catch (err) {
      console.warn('[update-market] re-audit failed (skip this round):', err);
    }
  }
}
