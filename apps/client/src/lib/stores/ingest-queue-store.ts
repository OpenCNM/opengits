import { create } from 'zustand';
import { DocumentStatus, STORAGE_KEYS } from '@/lib/constants';
import { api } from '@/lib/api/client';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';
import { createMemoizedSelector, shallowArrayEqual } from './memoize-selector';
import { normalizeDocPath, matchDocPath } from '@/lib/doc-path';
import { projectChapterLifecycleState, projectCourseLifecycleState } from '@/lib/state/curriculum-state-projector';
import type { TranscriptionJobStatus } from '@/lib/state/status-vocabularies';

/** 服务端共享转录任务概要（断点续接进度，Phase 3 #9；只含计数不含存档正文） */
export interface TranscriptionJobSummary {
  status: TranscriptionJobStatus;
  savedChunks: number;
  totalChunks: number | null;
  /** 全局排队位置（1 起，仅 QUEUED 且可认领时有值；null=不在可认领队列，如仓被暂停） */
  queuePosition?: number | null;
  /** 预计完成剩余秒数（无历史耗时不编数，为 null；<60s 由 UI 显示「即将完成」） */
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
  /**
   * 虚拟章节事实：大纲（navTree）中存在但 Document 表尚无物理行的课时占位符
   * （id 形如 `outline-<path>`，由 ingest-status 路由投影生成）。
   * 虚拟章无服务端任务可指涉，严禁对其发起插队/重试等写操作（投影层据此禁显动作按钮）。
   */
  isVirtual?: boolean;
}

/**
 * 轮询结果指纹（性能修复 2026-10-13）：剔除服务端每次现算、天然抖动的派生
 * 字段（etaSeconds）。指纹不变则跳过 documents/orderedPaths 的 set——此前每次
 * 轮询都新建数组引用，全体订阅 selector 空转重算（引用变了内容没变）。
 */
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

// 路径归一化与语义等价匹配的唯一事实源已抽取至 @/lib/doc-path（store 与投影引擎共用，杜绝循环依赖）。
// 此处保留 re-export，既有消费方（IngestProgressBar / SidebarProgressItem / 服务端路由）零迁移。
export { normalizeDocPath, matchDocPath } from '@/lib/doc-path';

/**
 * 归一化文档索引（零物化单槽 Memo）：以 documents 数组引用为缓存键，
 * 每次数组身份变更仅做 O(N) 归一化，侧栏每项查找从 O(N) 遍历降为 O(1) 点查，
 * 消除长目录场景下「N 项 × N 次遍历归一化」的 O(N²) 抖动。
 * 双键策略：raw 精确键优先，归一化键仅在缺席时补位（intro.md 与 intro.mdx 两行
 * 物理文档并存时互不覆盖，查找语义与原 find 的先精确后归一一致）。
 */
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

/**
 * 根据大纲物理拓扑次序对文档集合进行排序。
 */
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
  activeChapter: QueuedDocument | null;       // ⚡ 正在转录的章节
  nextChapter: QueuedDocument | null;         // ⏳ 待转录的下一章 (优先插队章必定置顶)
  pendingQueue: QueuedDocument[];            // 动态有序待转录队列
  isPrioritizedNext: boolean;                // 下一章是否为用户主动插队
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

  // 计数单一编码源：processed/total/progressPct/isCompleted 一律由课程投影器聚合，
  // 与 IngestProgressBar/侧栏口径严格一致（isPaused 仅影响宏观 state，不影响计数，传 false）
  const courseCounts = projectCourseLifecycleState(documents, false, {
    currentProcessingId,
    processingDocIds,
  });
  const total = courseCounts.total;
  const processed = courseCounts.processed;
  const progressPct = courseCounts.progressPct;
  const isCompleted = courseCounts.isCompleted;

  // 辅助判定：文档是否处于活跃执行/处理态（正在占用 worker 槽位）。
  // 单一编码源：完全委托纯投影器的 RUNNING 判定（物理 DB status 优先于瞬态任务/处理列表），
  // 杜绝本函数与 projectChapterLifecycleState 规则 3 双轨维护漂移。
  const isDocActive = (d: QueuedDocument): boolean =>
    projectChapterLifecycleState(d, { currentProcessingId, processingDocIds }) === 'RUNNING';

  // 1. 确定当前正在执行的章节（Active Chapter）
  const runningDoc = documents.find(isDocActive);
  const activeChapter = runningDoc ?? null;

  // 2. 收集所有未完成且非活跃执行中的待转录章节（排除所有正在 PROCESSING / RUNNING 的章节）
  const uncompletedDocs = documents.filter(
    (d) => d.status !== DocumentStatus.PROCESSED && !isDocActive(d) && d.id !== activeChapter?.id
  );

  // 3. 按照教学大纲物理次序排序
  const sortedPending = uncompletedDocs.length > 0
    ? sortDocsByNavOrder(uncompletedDocs, orderedPaths)
    : EMPTY_QUEUE;

  // 4. 用户显式插队（prioritizedId）置顶判定（支持 ID 或 path 匹配）
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

/**
 * 纯函数只读投影：根据底层物理事实 (documents, orderedPaths, prioritizedId, currentProcessingId, processingDocIds)
 * 投影出全局统一的转录执行看板状态。零物化，避免状态漂移。
 * 具备引用记忆（Memoized），输入未变时返回恒定引用，杜绝 React 18/19 useSyncExternalStore getSnapshot 循环重渲染。
 */
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
  /** 当前正在并发处理中的文档 ID 集合 */
  processingDocIds: string[];
  /** 向后兼容单文档引用：返回首个正在处理的 ID 或 null */
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

  // Actions
  initRepo: (owner: string, repo: string, edition?: string, initialEditions?: RepositoryEditionOption[]) => void;
  setDocuments: (docs: QueuedDocument[] | ((prev: QueuedDocument[]) => QueuedDocument[])) => void;
  setOrderedPaths: (paths: string[]) => void;
  setProcessingDocIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  setCurrentProcessingId: (id: string | null) => void;
  setPrioritizedId: (id: string | null) => void;
  pause: (mode?: 'immediate' | 'after_chapter') => void;
  resume: () => void;
  /** 插队指定文档；resolve 值为服务端是否接受（false=被拒/虚拟章守卫拦截，本地已回滚） */
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
    // 允许传入 docId 或 docPath，内部统一解析真实物理 ID
    const found = get().documents.find((d) => d.id === docId || matchDocPath(d.path, docId));

    // 虚拟章节事实门禁：大纲占位符（isVirtual）无服务端任务可指涉，
    // 严禁对其发起插队写请求——否则服务端必然 miss，本地乐观标记悬挂成幽灵 ⚡
    if (found?.isVirtual) {
      console.warn(`[IngestQueue] Refused to prioritize virtual outline placeholder: ${docId}`);
      return false;
    }

    const targetId = found ? found.id : docId;

    set({ prioritizedId: targetId });
    get().resume();

    // 如果目标文档处于 ERROR 状态，必须在服务端重置（/api/documents/[id]/reset），
    // 否则 refreshStatus 会用数据库真值把本地 UNPROCESSED 翻回 ERROR，导致重试静默失效
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

    // 同步到服务端高优先级队列，让 Go worker-sidecar 即时抢占
    // （优先级为服务端权威常量，客户端不再传值）。
    // 原子回滚：服务端拒绝（限流/任务不存在/网络失败）时撤销本地乐观标记，
    // 且仅在「当前优先 ID 仍为本次操作的 ID」时回滚，避免吞掉用户随后的再次插队
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
      // 被动轮询：匿名/会话过期静默失败，不弹登录
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

      // 竞态防御：网络请求在途期间若用户发生跨版本切换或切仓，响应已过时，严禁覆盖新讲法状态
      if (get().owner !== owner || get().repo !== repo || get().edition !== targetEdition) {
        return;
      }

      const prevOrderedPaths = get().orderedPaths;
      if (data.orderedPaths && Array.isArray(data.orderedPaths) && !sameStringArray(data.orderedPaths, prevOrderedPaths)) {
        set({ orderedPaths: data.orderedPaths });
      }
      const hasDocs = Array.isArray(data.documents);
      const sorted = hasDocs ? sortDocumentsByNavTree(data.documents) : get().documents;
      // 指纹命中（剔除 etaSeconds 抖动后内容无变化）跳过 documents set——
      // 不新建数组引用，消除全体订阅 selector 的空转重算
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
        // 指纹命中时保留原引用（runningIds 每次新建数组，同样会触发订阅空转）
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
      // 轮询在服务热重启、网络短暂离线、匿名无权访问私有讲法或频控冷却时忽略异常，避免干扰控制台与 dev overlay
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
