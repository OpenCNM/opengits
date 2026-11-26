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
      status: TranscriptionJobStatus;
      savedChunks: number;
      totalChunks: number | null;
      queuePosition?: number | null;
      claimedAt?: string | null;
      createdAt?: string | null;
      startedAtMs?: number | null;
    } | null;
  }>;
  avgJobSeconds?: number | null;
  publishRequested?: boolean;
}

export const GET = defineRoute<{ owner: string; repo: string }>({
  scope: 'GET /api/ingest-status/[owner]/[repo]',
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
    const avgJobSeconds = sidecarRes.avgJobSeconds ?? null;

    const ingestPrefix = (repository.repoProfile as any)?.ingestPrefix as string | undefined;
    const scopedDocuments = ingestPrefix
      ? documents.filter(
          (doc) =>
            virtualChapterPathPrefixes.some((prefix) => doc.path.startsWith(prefix)) ||
            doc.path === ingestPrefix ||
            doc.path.startsWith(ingestPrefix.endsWith('/') ? ingestPrefix : `${ingestPrefix}/`)
        )
      : documents;

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

    const { getEffectiveRuntimeConcurrency } = await import('@/lib/gateway/policy');
    const runtimeConcurrency = await getEffectiveRuntimeConcurrency();
    const etaConcurrency = Math.max(1, runtimeConcurrency.effective.transcriptionConcurrency);
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

    const scopedDocMap = new Map<string, (typeof scopedDocuments)[number]>();
    for (const doc of scopedDocuments) {
      const prev = scopedDocMap.get(doc.path);
      if (!prev || (prev.status !== DocumentStatus.PROCESSED && doc.status === DocumentStatus.PROCESSED)) {
        scopedDocMap.set(doc.path, doc);
      }
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
      const seenPaths = new Set<string>();
      finalDocs = [];
      for (const p of orderedPaths) {
        if (seenPaths.has(p)) continue;
        seenPaths.add(p);
        const existing = scopedDocMap.get(p) ?? scopedDocMap.get(normalizeDocPath(p));
        if (existing) {
          const { transcriptionJob, ...doc } = existing;
          finalDocs.push({
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
          });
        } else {
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
