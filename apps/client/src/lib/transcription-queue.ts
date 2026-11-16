import { prisma } from '@/lib/db';
import { DocumentStatus } from '@/lib/constants';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * ─────────────────────────────────────────────────────────────
 * 服务端共享转录队列：生产者侧（Phase 2 #5）。
 *
 * 消费循环已由 Go worker-sidecar TranscriptionRunner 全量接管（认领/执行/
 * 终态/孤儿回收/通知均 Go 单写者）——Node 侧遗留的 claim/消费/失败/通知
 * 代码已物理删除（零破窗；暂停仓过滤与失败通知已收敛进 Go 侧
 * queries/transcription.sql）。2026-10 收口：同步执行器与浏览器直连链
 * 双轨退役（chunk 断点存档随之下线——Go body 进程内直写），本文件只剩：
 * - 入队幂等（JIT 打开入口 / process / resume route）
 * - 教学次序与拓扑优先级计算（入队前纯函数）
 * ─────────────────────────────────────────────────────────────
 */

/** JIT 打开入口入队（幂等）：DONE 重开、QUEUED/RUNNING 保持 */
export interface TranscriptionEnqueueOptions {
  enhance?: boolean;
  model?: string;
  targetLanguage?: string;
  customPrompt?: string;
  transcriptionPreset?: string;
  aiCondensation?: string;
  teachingDepth?: string;
  teachingOrder?: number;
  priority?: number;
}

/**
 * 纯函数解析文档的教学次序（teachingOrder）。
 * 优先级：显式 options.teachingOrder -> docPath 中的数字（如 chapters/01.mdx -> 1）-> repoProfile.codeClusters 匹配。
 */
export function resolveTeachingOrder(
  docPath?: string | null,
  options?: TranscriptionEnqueueOptions,
  repoProfile?: Record<string, unknown> | null
): number | null {
  if (typeof options?.teachingOrder === 'number' && options.teachingOrder > 0) {
    return options.teachingOrder;
  }
  if (docPath) {
    const base = docPath.split('/').pop() ?? '';
    const match = base.match(/\d+/);
    if (match) {
      const parsed = parseInt(match[0], 10);
      if (parsed > 0) {
        return parsed;
      }
    }
  }
  if (repoProfile && Array.isArray(repoProfile.codeClusters)) {
    const clusters = repoProfile.codeClusters as Array<Record<string, unknown>>;
    const base = docPath ? (docPath.split('/').pop() ?? '') : '';
    for (const c of clusters) {
      if (typeof c === 'object' && c !== null) {
        const order = typeof c.teachingOrder === 'number' && c.teachingOrder > 0
          ? c.teachingOrder
          : (typeof c.chapterNo === 'number' && c.chapterNo > 0 ? c.chapterNo : null);
        if (order) {
          if (Array.isArray(c.files) && docPath && c.files.includes(docPath)) {
            return order;
          }
          if (typeof c.title === 'string' && base && c.title.toLowerCase().includes(base.toLowerCase())) {
            return order;
          }
        }
      }
    }
  }
  return null;
}

/**
 * 拓扑优先级计算（Topological Priority Boost）。
 * 前置基础章节赋更高基准分（10000 - order * 20），结合热度 views，
 * 确保 PostgreSQL SKIP LOCKED 自然按拓扑瀑布级联认领，消除无序并发逆序。
 */
export function computeTopologicalPriority(
  order: number | null,
  views: number = 0,
  explicitPriority?: number
): number {
  if (typeof explicitPriority === 'number') {
    return explicitPriority;
  }
  const topoBoost = order && order > 0 ? Math.max(0, 10000 - order * 20) : 0;
  return topoBoost + (views > 0 ? views : 0);
}

export async function enqueueTranscription(
  documentId: string,
  requestedBy: string,
  options?: TranscriptionEnqueueOptions
): Promise<'queued' | 'exists' | 'reset'> {
  // 确保文档状态标记为 PROCESSING（若尚未 PROCESSED），防止前端轮询时产生状态回退死循环
  if (typeof prisma.document?.updateMany === 'function') {
    await prisma.document
      .updateMany({
        where: { id: documentId, status: { not: DocumentStatus.PROCESSED } },
        data: { status: DocumentStatus.PROCESSING, errorMessage: null },
      })
      .catch(() => {});
  }

  const docInfo = await prisma.document
    .findUnique({
      where: { id: documentId },
      select: {
        path: true,
        repository: { select: { views: true, repoProfile: true } },
      },
    })
    .catch(() => null);

  const teachingOrder = resolveTeachingOrder(
    docInfo?.path,
    options,
    docInfo?.repository?.repoProfile as Record<string, unknown> | null
  );
  const priority = computeTopologicalPriority(
    teachingOrder,
    docInfo?.repository?.views ?? 0,
    options?.priority
  );

  try {
    const res = await callSidecar<{ status: 'queued' | 'exists' | 'reset' }>(
      '/v1/transcription/jobs/enqueue',
      {
        documentId,
        requestedBy,
        priority,
        options: options && Object.keys(options).length > 0 ? options : undefined,
      },
      { label: 'transcription-enqueue' }
    );
    return res.status;
  } catch (err) {
    // Step 2 失败：回滚 Document.status 为 UNPROCESSED，防止孤儿 PROCESSING 文档
    if (typeof prisma.document?.updateMany === 'function') {
      await prisma.document
        .updateMany({
          where: { id: documentId, status: DocumentStatus.PROCESSING },
          data: { status: DocumentStatus.UNPROCESSED, errorMessage: null },
        })
        .catch(() => {});
    }
    throw err;
  }
}

