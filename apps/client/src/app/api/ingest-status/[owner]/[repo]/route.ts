import { DocumentStatus } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { resolveEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { computeQueueEtaSeconds } from '@/lib/ingest-queue-eta';
import { callSidecar } from '@/lib/sidecar-client';
import { normalizeDocPath } from '@/lib/doc-path';
import { virtualChapterPathPrefixes } from '@/engine/scanner/repo-patterns';
import { projectPublishIntent } from '@/lib/state/publish-intent-projector';
import type { TranscriptionJobStatus } from '@/lib/state/status-vocabularies';

interface IngestStatusSidecarResponse {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  repository?: {
    id: string;
    owner: string;
    repo: string;
    branch: string;
    edition: string;
    isPublic: boolean;
    ownerUserId: string | null;
    transcriptionPaused: boolean;
    reviewStatus: string;
    publishedAt: string | null;
    transcriptionCreditsEarned: number;
    transcriptionTokens?: number;
    repoProfile: Record<string, unknown> | null;
    navTree: unknown;
  };
  documents?: Array<{
    id: string;
    path: string;
    title: string | null;
    status: string;
    errorMessage: string | null;
    transcriptionJob: {
      /** Go internal/transcription/states.go 四态契约（QUEUED/RUNNING/DONE/FAILED，逐字保证） */
      status: TranscriptionJobStatus;
      savedChunks: number;
      totalChunks: number | null;
      /** 全局排队位置（1 起，仅 QUEUED 且可认领时有值） */
      queuePosition?: number | null;
      claimedAt?: string | null;
      createdAt?: string | null;
      startedAtMs?: number | null;
    } | null;
  }>;
  /** 最近 DONE 任务平均耗时（秒）；ETA 计算输入，不透传前端 */
  avgJobSeconds?: number | null;
  publishRequested?: boolean;
}

export const GET = defineRoute<{ owner: string; repo: string }>({
  scope: 'GET /api/ingest-status/[owner]/[repo]',
  // 匿名可查公开仓的转录状态（documents 按登录态过滤私有副本）
  auth: 'public',
  handler: async ({ params, userId, request }) => {
    const { owner, repo } = params;
    const { editionParamFromUrl, resolveRepository } = await import('@/lib/repository-resolver');
    const edition = editionParamFromUrl(request);

    let explicitBranch: string | undefined;
    try {
      const url = new URL(request.url);
      explicitBranch = url.searchParams.get('branch')?.trim() || undefined;
    } catch {}

    const resolved = await resolveRepository(owner, repo, explicitBranch, edition);
    const branch = explicitBranch || resolved?.resolvedBranch || ENGINE_CONFIG.defaultBranch;
    const effectiveEdition = resolved ? resolved.resolvedEdition : (edition || null);

    const sidecarRes = await callSidecar<IngestStatusSidecarResponse>(
      '/v1/repos/ingest-status',
      {
        owner,
        repo,
        branch,
        edition: effectiveEdition,
        userId: userId || null,
      },
      { label: 'ingest-status /v1/repos/ingest-status', timeoutMs: 5_000 }
    );

    if (sidecarRes.forbidden) {
      throw ApiError.forbidden('You do not have access to this repository status', { code: 'FORBIDDEN' });
    }

    if (sidecarRes.notFound || !sidecarRes.repository) {
      throw ApiError.notFound('Repository not found', { code: 'REPOSITORY_NOT_FOUND' });
    }

    const repository = sidecarRes.repository;
    const documents = sidecarRes.documents || [];
    const publishRequested = Boolean(sidecarRes.publishRequested);
    // 最近 DONE 平均耗时（秒）——排队 ETA 的输入事实（无历史为 null）
    const avgJobSeconds = sidecarRes.avgJobSeconds ?? null;

    // 按最近一次导入的作用域过滤文档:仓库曾以不同前缀(如先全仓、后选子目录)导入时,
    // 进度环/书架只显示当前作用域的文档,避免"选了文件夹却显示全仓转录"。
    // 虚拟代码章节（前缀清单 SSOT：engine/scanner/repo-patterns.virtualChapterPathPrefixes）
    // 为全局教程产物，绝不可被源码子目录前缀过滤。老仓库无 ingestPrefix→不过滤,行为不变。
    const ingestPrefix = (repository.repoProfile as any)?.ingestPrefix as string | undefined;
    const scopedDocuments = ingestPrefix
      ? documents.filter(
          (doc) =>
            virtualChapterPathPrefixes.some((prefix) => doc.path.startsWith(prefix)) ||
            doc.path === ingestPrefix ||
            doc.path.startsWith(ingestPrefix.endsWith('/') ? ingestPrefix : `${ingestPrefix}/`)
        )
      : documents;

    /**
     * 物理终态门禁（Terminal Fact Invariant，网络层焊死）：
     * DB 中 PROCESSED / ERROR 为不可逆终态。滞留的 RUNNING/QUEUED 任务行
     * （如 worker 崩溃后未收尾的历史任务）严禁将其翻转为中间态——否则客户端
     * 投影器收到的是已被污染的 status，终态防线在数据源头即告失守。
     * 返回值收窄为 DocumentStatus：响应边界即类型边界，服务端新增状态值在此显式失败。
     */
    const effectiveStatus = (
      doc: { status: string },
      transcriptionJob?: { status: TranscriptionJobStatus } | null
    ): DocumentStatus => {
      if (doc.status === DocumentStatus.PROCESSED) return DocumentStatus.PROCESSED;
      if (doc.status === DocumentStatus.ERROR) return DocumentStatus.ERROR;
      if (transcriptionJob?.status === 'RUNNING') return DocumentStatus.PROCESSING;
      if (transcriptionJob?.status === 'QUEUED') return DocumentStatus.UNPROCESSED;
      return doc.status as DocumentStatus;
    };

    // Build orderedPaths and titleMap from effective navTree to match sidebar menu order exactly
    const titleMap = new Map<string, string>();
    const orderedPaths: string[] = [];

    const navTree = await resolveEffectiveNavTree(repository.id, {
      owner: repository.owner,
      repo: repository.repo,
      fallbackNavTree: repository.navTree,
    });

    const traverseNavTree = (nodes: any[]) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node.path && node.type !== 'directory') {
          orderedPaths.push(node.path);
          const title = node.shortTitle || node.title;
          if (title) titleMap.set(node.path, title);
        }
        if (node.files && Array.isArray(node.files)) {
          for (const f of node.files) {
            if (f.path && f.type !== 'directory') {
              orderedPaths.push(f.path);
              const title = f.shortTitle || f.title;
              if (title) titleMap.set(f.path, title);
            }
          }
        }
        if (node.children && Array.isArray(node.children)) {
          traverseNavTree(node.children);
        }
      }
    };
    try {
      traverseNavTree(navTree as any[]);
    } catch (e) {
      console.error('Error parsing navTree in status route', e);
    }

    // 排队 ETA：以 worker 并发槽位与最近平均耗时估算完成剩余秒数；
    // avgJobSeconds 只作输入事实，不随响应下发（下游只需结论，秒级精度留给 UI 区分「即将完成」）
    const etaConcurrency = Math.max(1, ENGINE_CONFIG.serverTranscription.concurrency);
    const etaSecondsFor = (tj: {
      status: string;
      savedChunks: number;
      totalChunks: number | null;
      queuePosition?: number | null;
    }): number | null =>
      computeQueueEtaSeconds({
        status: tj.status,
        queuePosition: tj.queuePosition ?? null,
        avgJobSeconds,
        savedChunks: tj.savedChunks,
        totalChunks: tj.totalChunks ?? null,
        concurrency: etaConcurrency,
      });

    // ── 大纲即作用域（Outline As Scope - 346 统一认知 #4：File ≠ Cognitive Unit）：
    // 教学大纲（TutorialOutline / navTree）是认知单元的唯一事实源。
    // 前端进度环与转录任务坞（UnifiedTaskDock）必须与外部书架/首页口径严格对齐，
    // 仅计入教学大纲作用域内的课时；物理 Document 仅在无大纲的存量冷仓中兜底平铺。
    const scopedDocMap = new Map<string, (typeof scopedDocuments)[number]>();
    for (const doc of scopedDocuments) {
      const prev = scopedDocMap.get(doc.path);
      // 若同 path 存在多行（如公共基线与私有定制副本），优先选用已处理或有效版本
      if (!prev || (prev.status !== DocumentStatus.PROCESSED && doc.status === DocumentStatus.PROCESSED)) {
        scopedDocMap.set(doc.path, doc);
      }
      // 归一化键兜底：容错 navTree 无扩展名/斜杠差异，消灭假性 outline- 占位符。
      // 双键策略：仅缺席时补位——intro.md 与 intro.mdx 两行物理文档并存时互不覆盖，
      // 杜绝归一化碰撞吞行（先精确、后归一的查找语义与客户端 getNormalizedDocMap 对齐）
      const normKey = normalizeDocPath(doc.path);
      if (normKey && normKey !== doc.path) {
        const prevNorm = scopedDocMap.get(normKey);
        if (!prevNorm || (prevNorm.status !== DocumentStatus.PROCESSED && doc.status === DocumentStatus.PROCESSED)) {
          scopedDocMap.set(normKey, doc);
        }
      }
    }

    let finalDocs: Array<{
      id: string;
      path: string;
      title: string | null;
      status: DocumentStatus;
      errorMessage: string | null;
      /** 大纲存在但 Document 表无物理行的虚拟占位符（消费端严禁对其发起插队/重试写操作） */
      isVirtual?: boolean;
      transcriptionJob: {
        status: TranscriptionJobStatus;
        savedChunks: number;
        totalChunks: number | null;
        queuePosition?: number | null;
        etaSeconds?: number | null;
        claimedAt?: string | null;
        createdAt?: string | null;
        startedAt?: number | null;
      } | null;
    }>;

    if (orderedPaths.length > 0) {
      // 保持 orderedPaths 的顺序，并去重（避免单文件多锚点章导致计数虚增）
      const seenPaths = new Set<string>();
      finalDocs = [];
      for (const p of orderedPaths) {
        if (seenPaths.has(p)) continue;
        seenPaths.add(p);
        // 先精确后归一双键查找（与客户端 getNormalizedDocMap 语义对齐）
        const existing = scopedDocMap.get(p) ?? scopedDocMap.get(normalizeDocPath(p));
        if (existing) {
          const { transcriptionJob, ...doc } = existing;
          finalDocs.push({
            ...doc,
            status: effectiveStatus(doc, transcriptionJob),
            title: titleMap.get(doc.path) || doc.title || null,
            // 只投影计数与排队位置/ETA/物理时间戳，绝不外发存档正文（chunk 成品属于文档内容层）
            transcriptionJob: transcriptionJob
              ? {
                  status: transcriptionJob.status,
                  savedChunks: transcriptionJob.savedChunks,
                  totalChunks: transcriptionJob.totalChunks ?? null,
                  queuePosition: transcriptionJob.queuePosition ?? null,
                  etaSeconds: etaSecondsFor(transcriptionJob),
                  claimedAt: transcriptionJob.claimedAt ?? null,
                  createdAt: transcriptionJob.createdAt ?? null,
                  startedAt:
                    transcriptionJob.startedAtMs ??
                    (transcriptionJob.claimedAt
                      ? new Date(transcriptionJob.claimedAt).getTime()
                      : transcriptionJob.createdAt
                        ? new Date(transcriptionJob.createdAt).getTime()
                        : null),
                }
              : null,
          });
        } else {
          // 大纲中有该课时但在 Document 表尚无物理行：作为 UNPROCESSED 投影。
          // isVirtual=true 显式声明虚拟事实，客户端据此禁显插队/重试动作
          finalDocs.push({
            id: `outline-${p}`,
            path: p,
            title: titleMap.get(p) || p,
            status: DocumentStatus.UNPROCESSED,
            errorMessage: null,
            isVirtual: true,
            transcriptionJob: null,
          });
        }
      }
    } else {
      // 无大纲的冷旧存量仓：回退平铺物理文档，并按字母序排列
      finalDocs = scopedDocuments.map(({ transcriptionJob, ...doc }) => ({
        ...doc,
        status: effectiveStatus(doc, transcriptionJob),
        title: titleMap.get(doc.path) || doc.title || null,
        transcriptionJob: transcriptionJob
          ? {
              status: transcriptionJob.status,
              savedChunks: transcriptionJob.savedChunks,
              totalChunks: transcriptionJob.totalChunks ?? null,
              queuePosition: transcriptionJob.queuePosition ?? null,
              etaSeconds: etaSecondsFor(transcriptionJob),
              claimedAt: transcriptionJob.claimedAt ?? null,
              createdAt: transcriptionJob.createdAt ?? null,
              startedAt:
                transcriptionJob.startedAtMs ??
                (transcriptionJob.claimedAt
                  ? new Date(transcriptionJob.claimedAt).getTime()
                  : transcriptionJob.createdAt
                    ? new Date(transcriptionJob.createdAt).getTime()
                    : null),
            }
          : null,
      }));
      finalDocs.sort((a, b) => a.path.localeCompare(b.path));
    }

    // 闭环自愈：发布意图单一仲裁点（与客户端自动发布 effect 共用同一纯投影）。
    // 若任务创建时勾选了公开（publishRequested），且全量文档转录完成、尚处于私有草稿态，
    // 则主动触发发布流水线（走 License Gate + 平台安全审核 + 评分 + publishedAt）
    const allProcessed =
      finalDocs.length > 0 && finalDocs.every((d) => d.status === 'PROCESSED');
    if (
      projectPublishIntent({
        publishRequested,
        isPublic: repository.isPublic,
        reviewStatus: repository.reviewStatus,
        allProcessed,
      }) === 'READY_TO_SUBMIT'
    ) {
      const { resolveMaintainerUserId } = await import('@/lib/repository-maintainer');
      const { publishRepository } = await import('@/lib/review/publish-repository');
      const maintainerId = (await resolveMaintainerUserId(repository.id)) || userId;
      if (maintainerId) {
        void publishRepository(maintainerId, { repoId: repository.id })
          .catch((err) => console.warn('[ingest-status] Auto-publish trigger deferred:', err));
      }
    }

    const { getRepositoryEditions } = await import('@/lib/repository-resolver');
    const editions = await getRepositoryEditions(owner, repo, { userId }).catch(() => []);

    return ok({
      repositoryId: repository.id,
      navTree,
      orderedPaths,
      documents: finalDocs,
      transcriptionPaused: repository.transcriptionPaused,
      transcriptionTokens: repository.transcriptionTokens ?? 0,
      isPublic: repository.isPublic,
      reviewStatus: repository.reviewStatus,
      publishedAt: repository.publishedAt ? new Date(repository.publishedAt).toISOString() : null,
      transcriptionCreditsEarned: repository.transcriptionCreditsEarned,
      publishRequested,
      editions,
    });
  },
});
