import { prisma } from '@/lib/db';
import { ignoreBestEffort } from '@/lib/best-effort';
import { DocumentStatus } from '@/lib/constants';
import { callSidecar } from '@/lib/sidecar-client';

// Producer-only enqueue helper; Go worker-sidecar owns claim, execution, and terminal state transitions.

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

// Base score 10000 - order*20 ensures earlier chapters drain first under PostgreSQL SKIP LOCKED.
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
  if (typeof prisma.document?.updateMany === 'function') {
    await prisma.document
      .updateMany({
        where: { id: documentId, status: { not: DocumentStatus.PROCESSED } },
        data: { status: DocumentStatus.PROCESSING, errorMessage: null },
      })
      .catch(ignoreBestEffort);
  }

  const docInfo = await prisma.document
    .findUnique({
      where: { id: documentId },
      select: {
        path: true,
        repository: { select: { views: true, repoProfile: true } },
      },
    })
    .catch(() => { ignoreBestEffort(); return null; });

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
    // Roll back PROCESSING status on enqueue failure to prevent orphaned stuck documents.
    if (typeof prisma.document?.updateMany === 'function') {
      await prisma.document
        .updateMany({
          where: { id: documentId, status: DocumentStatus.PROCESSING },
          data: { status: DocumentStatus.UNPROCESSED, errorMessage: null },
        })
        .catch(ignoreBestEffort);
    }
    throw err;
  }
}

