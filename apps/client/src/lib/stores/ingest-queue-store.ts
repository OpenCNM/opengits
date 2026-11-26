import { create } from 'zustand';
import { DocumentStatus, STORAGE_KEYS } from '@/lib/constants';
import { api } from '@/lib/api/client';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';
import { createMemoizedSelector, shallowArrayEqual } from './memoize-selector';
import { normalizeDocPath, matchDocPath } from '@/lib/doc-path';
import { projectChapterLifecycleState, projectCourseLifecycleState } from '@/lib/state/curriculum-state-projector';
import type { TranscriptionJobStatus } from '@/lib/state/status-vocabularies';

export interface TranscriptionJobSummary {
  status: TranscriptionJobStatus;
  savedChunks: number;
  totalChunks: number | null;
  queuePosition?: number | null;
  etaSeconds?: number | null;
  claimedAt?: string | null;
  createdAt?: string | null;
  startedAt?: number | null;
  progress?: number | null;
  step?: string | null;
}

export interface QueuedDocument {
  id: string;
  path: string;
  title: string | null;
  status: DocumentStatus;
  errorMessage: string | null;
  transcriptionJob?: TranscriptionJobSummary | null;
  isVirtual?: boolean;
}

function pollDocumentsFingerprint(docs: QueuedDocument[]): string {
  return JSON.stringify(
    docs.map((d) => [
      d.id,
      d.path,
      d.title ?? null,
      d.status,
      d.errorMessage ?? null,
      d.transcriptionJob
        ? [
            d.transcriptionJob.status ?? null,
            d.transcriptionJob.savedChunks ?? null,
            d.transcriptionJob.totalChunks ?? null,
            d.transcriptionJob.queuePosition ?? null,
            d.transcriptionJob.startedAt ?? null,
          ]
        : null,
    ])
  );
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { normalizeDocPath, matchDocPath } from '@/lib/doc-path';

let normalizedDocMapCache: { src: QueuedDocument[]; map: Map<string, QueuedDocument> } | null = null;
export function getNormalizedDocMap(documents: QueuedDocument[]): Map<string, QueuedDocument> {
  if (normalizedDocMapCache && normalizedDocMapCache.src === documents) {
    return normalizedDocMapCache.map;
  }
  const map = new Map<string, QueuedDocument>();
  for (const d of documents) {
    map.set(d.path, d);
    const n = normalizeDocPath(d.path);
    if (n && n !== d.path && !map.has(n)) {
      map.set(n, d);
    }
  }
  normalizedDocMapCache = { src: documents, map };
  return map;
}

export function sortDocsByNavOrder(docs: QueuedDocument[], orderedPaths: string[]): QueuedDocument[] {
  if (!orderedPaths || orderedPaths.length === 0) return docs;
  const normMap = new Map<string, number>();
  orderedPaths.forEach((p, idx) => {
    normMap.set(p, idx);
    const n = normalizeDocPath(p);
    if (n && !normMap.has(n)) {
      normMap.set(n, idx);
    }
  });

  const getRank = (doc: QueuedDocument): number => {
    if (normMap.has(doc.path)) return normMap.get(doc.path)!;
    const n = normalizeDocPath(doc.path);
    if (normMap.has(n)) return normMap.get(n)!;
    return -1;
  };

  const outlineDocs = docs.filter((d) => getRank(d) !== -1);
  const targetDocs = outlineDocs.length > 0 ? outlineDocs : docs;

  return [...targetDocs].sort((a, b) => {
    const rankA = getRank(a);
    const rankB = getRank(b);
    if (rankA !== -1 && rankB !== -1) return rankA - rankB;
    if (rankA !== -1) return -1;
    if (rankB !== -1) return 1;
    return a.path.localeCompare(b.path);
  });
}

export interface TranscriptionQueueProjection {
  total: number;
  processed: number;
  progressPct: number;
  isCompleted: boolean;
  activeChapter: QueuedDocument | null;
  nextChapter: QueuedDocument | null;
  pendingQueue: QueuedDocument[];
  isPrioritizedNext: boolean;
}

const EMPTY_QUEUE: QueuedDocument[] = [];

export type TranscriptionProjectionInput = Pick<
  IngestQueueStoreState,
  'documents' | 'orderedPaths' | 'prioritizedId' | 'currentProcessingId' | 'processingDocIds'
>;

function computeTranscriptionProjection(
  state: TranscriptionProjectionInput
): TranscriptionQueueProjection {
  const documents = state.documents || EMPTY_QUEUE;
  const orderedPaths = state.orderedPaths || [];
  const prioritizedId = state.prioritizedId ?? null;
  const currentProcessingId = state.currentProcessingId ?? null;
  const processingDocIds = state.processingDocIds || [];

  const courseCounts = projectCourseLifecycleState(documents, false, {
    currentProcessingId,
    processingDocIds,
  });
  const total = courseCounts.total;
  const processed = courseCounts.processed;
  const progressPct = courseCounts.progressPct;
  const isCompleted = courseCounts.isCompleted;

  const isDocActive = (d: QueuedDocument): boolean =>
    projectChapterLifecycleState(d, { currentProcessingId, processingDocIds }) === 'RUNNING';

  const runningDoc = documents.find(isDocActive);
  const activeChapter = runningDoc ?? null;

  const uncompletedDocs = documents.filter(
    (d) => d.status !== DocumentStatus.PROCESSED && !isDocActive(d) && d.id !== activeChapter?.id
  );

  const sortedPending = uncompletedDocs.length > 0
    ? sortDocsByNavOrder(uncompletedDocs, orderedPaths)
    : EMPTY_QUEUE;

  let pendingQueue: QueuedDocument[] = sortedPending;
  let isPrioritizedNext = false;

  if (prioritizedId && sortedPending.length > 0) {
    const priIdx = sortedPending.findIndex(
      (d) => d.id === prioritizedId || matchDocPath(d.path, prioritizedId)
    );
    if (priIdx !== -1) {
      const priDoc = sortedPending[priIdx];
      pendingQueue = [priDoc, ...sortedPending.slice(0, priIdx), ...sortedPending.slice(priIdx + 1)];
      isPrioritizedNext = true;
    }
  }

  const nextChapter = pendingQueue.length > 0 ? pendingQueue[0] : null;

  return {
    total,
    processed,
    progressPct,
    isCompleted,
    activeChapter,
    nextChapter,
    pendingQueue,
    isPrioritizedNext,
  };
}

function isProjectionInputEqual(
  p: TranscriptionProjectionInput,
  n: TranscriptionProjectionInput
): boolean {
  if (p === n) return true;
  if (!p || !n) return false;
  return (
    p.documents === n.documents &&
    (p.prioritizedId ?? null) === (n.prioritizedId ?? null) &&
    (p.currentProcessingId ?? null) === (n.currentProcessingId ?? null) &&
    shallowArrayEqual(p.orderedPaths, n.orderedPaths) &&
    shallowArrayEqual(p.processingDocIds, n.processingDocIds)
  );
}

export const selectTranscriptionProjection = createMemoizedSelector(
  computeTranscriptionProjection,
  isProjectionInputEqual
);

export interface IngestQueueStoreState {
  owner: string;
  repo: string;
  documents: QueuedDocument[];
  isPaused: boolean;
  pauseMode: 'immediate' | 'after_chapter' | null;
  processingDocIds: string[];
  currentProcessingId: string | null;
  prioritizedId: string | null;
  orderedPaths: string[];
  repositoryId: string | null;
  edition: string;
  availableEditions: RepositoryEditionOption[];
  isPublic: boolean;
  reviewStatus: string | null;
  publishedAt: string | null;
  transcriptionCreditsEarned: number;
  transcriptionTokens: number;
  publishRequested: boolean;

  initRepo: (owner: string, repo: string, edition?: string, initialEditions?: RepositoryEditionOption[]) => void;
  setDocuments: (docs: QueuedDocument[] | ((prev: QueuedDocument[]) => QueuedDocument[])) => void;
  setOrderedPaths: (paths: string[]) => void;
  setProcessingDocIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  setCurrentProcessingId: (id: string | null) => void;
  setPrioritizedId: (id: string | null) => void;
  pause: (mode?: 'immediate' | 'after_chapter') => void;
  resume: () => void;
  prioritize: (docId: string) => Promise<boolean>;
  regenerate: (docId: string) => Promise<void>;
  refreshStatus: (overrideEdition?: string) => Promise<void>;
  sortDocumentsByNavTree: (docs: QueuedDocument[]) => QueuedDocument[];
  syncPauseToServer: (paused: boolean) => Promise<void>;
}

export const useIngestQueueStore = create<IngestQueueStoreState>((set, get) => ({
  owner: '',
  repo: '',
  documents: [],
  isPaused: false,
  pauseMode: null,
  processingDocIds: [],
  currentProcessingId: null,
  prioritizedId: null,
  orderedPaths: [],
  repositoryId: null,
  edition: '',
  availableEditions: [],
  isPublic: false,
  reviewStatus: null,
  publishedAt: null,
  transcriptionCreditsEarned: 0,
  transcriptionTokens: 0,
  publishRequested: false,

  initRepo: (owner: string, repo: string, edition = '', initialEditions?: RepositoryEditionOption[]) => {
    const currentOwner = get().owner;
    const currentRepo = get().repo;
    const currentEdition = get().edition;
    if (currentOwner === owner && currentRepo === repo && currentEdition === edition) {
      if (initialEditions && initialEditions.length > 0) {
        set({ availableEditions: initialEditions });
      }
      return;
    }

    let savedPause = false;
    if (typeof window !== 'undefined') {
      savedPause = localStorage.getItem(STORAGE_KEYS.INGEST_PAUSED(owner, repo)) === 'true';
    }

    set({
      owner,
      repo,
      edition,
      availableEditions: initialEditions ?? [],
      documents: [],
      isPaused: savedPause,
      pauseMode: null,
      processingDocIds: [],
      currentProcessingId: null,
      prioritizedId: null,
      orderedPaths: [],
      repositoryId: null,
      isPublic: false,
      reviewStatus: null,
      publishedAt: null,
      transcriptionCreditsEarned: 0,
      transcriptionTokens: 0,
      publishRequested: false,
    });
  },

  sortDocumentsByNavTree: (docs: QueuedDocument[]): QueuedDocument[] => {
    return sortDocsByNavOrder(docs, get().orderedPaths);
  },

  setDocuments: (docs) => {
    const nextDocs = typeof docs === 'function' ? docs(get().documents) : docs;
    set({ documents: nextDocs });
  },

  setOrderedPaths: (paths) => set({ orderedPaths: paths }),
  setProcessingDocIds: (ids) => {
    const nextIds = typeof ids === 'function' ? ids(get().processingDocIds) : ids;
    set({
      processingDocIds: nextIds,
      currentProcessingId: nextIds.length > 0 ? nextIds[0] : null,
    });
  },
  setCurrentProcessingId: (id) =>
    set((s) => ({
      currentProcessingId: id,
      processingDocIds: id
        ? s.processingDocIds.includes(id)
          ? s.processingDocIds
          : [id, ...s.processingDocIds]
        : [],
    })),
  setPrioritizedId: (id) => set({ prioritizedId: id }),

  syncPauseToServer: async (paused: boolean) => {
    const { owner, repo, edition } = get();
    if (!owner || !repo) return;
    const editionQuery = edition ? `?edition=${encodeURIComponent(edition)}` : '';
    try {
      await api.post(`/api/ingest/${owner}/${repo}/pause${editionQuery}`, { paused });
    } catch (err) {
      console.error('Failed to sync pause state to server:', err);
    }
  },

  pause: (mode = 'immediate') => {
    const { owner, repo, processingDocIds, currentProcessingId, syncPauseToServer } = get();
    if (mode === 'immediate') {
      set({ isPaused: true, pauseMode: null });
      if (typeof window !== 'undefined' && owner && repo) {
        localStorage.setItem(STORAGE_KEYS.INGEST_PAUSED(owner, repo), 'true');
      }
      void syncPauseToServer(true);

      const activeIds = new Set(processingDocIds);
      if (currentProcessingId) activeIds.add(currentProcessingId);

      set((s) => ({
        currentProcessingId: null,
        processingDocIds: [],
        documents: s.documents.map((d) =>
          activeIds.has(d.id) ? { ...d, status: DocumentStatus.UNPROCESSED } : d
        ),
      }));
    } else {
      set({ pauseMode: 'after_chapter' });
    }
  },

  resume: () => {
    const { owner, repo, syncPauseToServer } = get();
    set({ isPaused: false, pauseMode: null });
    if (typeof window !== 'undefined' && owner && repo) {
      localStorage.setItem(STORAGE_KEYS.INGEST_PAUSED(owner, repo), 'false');
    }
    void syncPauseToServer(false);
  },

  prioritize: async (docId: string): Promise<boolean> => {
    const found = get().documents.find((d) => d.id === docId || matchDocPath(d.path, docId));

    if (found?.isVirtual) {
      console.warn(`[IngestQueue] Refused to prioritize virtual outline placeholder: ${docId}`);
      return false;
    }

    const targetId = found ? found.id : docId;

    set({ prioritizedId: targetId });
    get().resume();

    if (found && found.status === DocumentStatus.ERROR) {
      try {
        await api.post(`/api/documents/${targetId}/reset`, undefined, { onUnauthorized: 'throw' });
        set((s) => ({
          documents: s.documents.map((d) =>
            d.id === targetId ? { ...d, status: DocumentStatus.UNPROCESSED, errorMessage: null } : d
          ),
        }));
      } catch (e) {
        console.error(`Failed to reset doc ${targetId} before prioritize:`, e);
      }
    }

    try {
      await api.post(`/api/documents/${targetId}/prioritize`, {});
    } catch (e) {
      if (get().prioritizedId === targetId) {
        set({ prioritizedId: null });
      }
      console.warn('Failed to prioritize document on server (rolled back locally):', e);
      return false;
    }

    await get().refreshStatus();
    return true;
  },

  regenerate: async (docId: string) => {
    const { refreshStatus } = get();
    try {
      await api.post(`/api/documents/${docId}/reset`, undefined, { onUnauthorized: 'throw' });
      set((s) => ({
        documents: s.documents.map((d) =>
          d.id === docId ? { ...d, status: DocumentStatus.UNPROCESSED, errorMessage: null } : d
        ),
      }));
      await get().prioritize(docId);
    } catch (err) {
      console.error('Failed to regenerate document:', err);
      await refreshStatus();
    }
  },

  refreshStatus: async (overrideEdition?: string) => {
    const { owner, repo, edition: storeEdition, sortDocumentsByNavTree } = get();
    if (!owner || !repo) return;
    const targetEdition = overrideEdition !== undefined ? overrideEdition : storeEdition;
    const editionQuery = targetEdition ? `?edition=${encodeURIComponent(targetEdition)}` : '';
    try {
      const data = await api.get<{
        repositoryId?: string;
        orderedPaths?: string[];
        documents: QueuedDocument[];
        transcriptionPaused?: boolean;
        isPublic?: boolean;
        reviewStatus?: string | null;
        publishedAt?: string | null;
        transcriptionCreditsEarned?: number;
        transcriptionTokens?: number;
        publishRequested?: boolean;
        editions?: RepositoryEditionOption[];
      }>(`/api/ingest-status/${owner}/${repo}${editionQuery}`, { onUnauthorized: 'throw', toastOnError: false });

      if (get().owner !== owner || get().repo !== repo || get().edition !== targetEdition) {
        return;
      }

      const prevOrderedPaths = get().orderedPaths;
      if (data.orderedPaths && Array.isArray(data.orderedPaths) && !sameStringArray(data.orderedPaths, prevOrderedPaths)) {
        set({ orderedPaths: data.orderedPaths });
      }
      const hasDocs = Array.isArray(data.documents);
      const sorted = hasDocs ? sortDocumentsByNavTree(data.documents) : get().documents;
      const documentsUnchanged =
        hasDocs && pollDocumentsFingerprint(sorted) === pollDocumentsFingerprint(get().documents);
      const runningIds = sorted
        .filter(
          (d) =>
            d.transcriptionJob?.status !== 'QUEUED' &&
            (d.status === DocumentStatus.PROCESSING || d.transcriptionJob?.status === 'RUNNING')
        )
        .map((d) => d.id);
      set((s) => ({
        ...(hasDocs && !documentsUnchanged ? { documents: sorted } : {}),
        processingDocIds: documentsUnchanged ? s.processingDocIds : runningIds,
        currentProcessingId: documentsUnchanged
          ? s.currentProcessingId
          : runningIds.length > 0
            ? runningIds[0]
            : null,
        prioritizedId:
          s.prioritizedId &&
          sorted.some(
            (d) =>
              (d.id === s.prioritizedId || matchDocPath(d.path, s.prioritizedId)) &&
              d.status === DocumentStatus.PROCESSED
          )
            ? null
            : s.prioritizedId,
        isPaused: data.transcriptionPaused === true ? true : s.isPaused,
        repositoryId: data.repositoryId ?? s.repositoryId,
        isPublic: data.isPublic ?? s.isPublic,
        reviewStatus: data.reviewStatus !== undefined ? data.reviewStatus : s.reviewStatus,
        publishedAt: data.publishedAt !== undefined ? data.publishedAt : s.publishedAt,
        transcriptionCreditsEarned: data.transcriptionCreditsEarned ?? s.transcriptionCreditsEarned,
        transcriptionTokens: data.transcriptionTokens ?? s.transcriptionTokens,
        publishRequested: data.publishRequested ?? s.publishRequested,
        availableEditions: data.editions !== undefined ? data.editions : s.availableEditions,
      }));
    } catch (err) {
      const isIgnorable =
        err instanceof Error &&
        (err.message.includes('fetch') ||
          err.message.includes('Network') ||
          (err as any).code === 'NETWORK_ERROR' ||
          (err as any).code === 'RATE_LIMITED' ||
          (err as any).code === 'FORBIDDEN' ||
          (err as any).code === 'UNAUTHORIZED' ||
          (err as any).status === 401 ||
          (err as any).status === 403 ||
          (err as any).status === 429 ||
          err.message.includes('429') ||
          err.message.includes('Too Many Requests'));
      if (!isIgnorable) {
        console.error('Failed to fetch ingest status:', err);
      }
    }
  },
}));
