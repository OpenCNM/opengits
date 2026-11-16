import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toastManager } from '@/components/ui/toast';
import { requireApiKey } from '@/lib/api-key-guard';
import { api, ApiClientError } from '@/lib/api/client';
import * as m from '@/paraglide/messages';
import { useRelayTaskStore } from '@/lib/stores/relay-task-store';
import type { RepoUpdateJobItem } from './WorkbenchBatchView';
import type { RelayParticipant } from '../RelayAvatarStack';

export interface RelayOutlineNode {
  id: string;
  documentId?: string;
  title: string;
  path: string;
  status: 'PROCESSED' | 'CLAIMED' | 'UNPROCESSED';
  versionCount?: number;
  claimedBy?: string | null;
  jobId?: string | null;
}

export interface RelayOutlineChapter {
  id: string;
  title: string;
  teachingOrder?: number;
  nodes: RelayOutlineNode[];
}

export interface RelayRepoMeta {
  owner: string;
  repo: string;
  title?: string;
  description?: string;
  totalDocs?: number;
  processedDocs?: number;
  progressPercent?: number;
  participants?: RelayParticipant[];
  /** 质量熔断：复检分跌破线，auto-update 整体跳过（维护者可见性） */
  qualityHold?: boolean;
}

export interface RelaySuccessResult {
  nodeId: string;
  path: string;
  title: string;
  chapterTitle?: string | null;
  durationSeconds: number;
  tokensUsed: number;
  model: string;
  frozenCredits: number;
  owner: string;
  repo: string;
}


export interface UseUpdateWorkbenchOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  repo: string;
  edition?: string;
  initialJobId?: string | null;
  isLoggedIn: boolean;
  onJobResolved?: () => void;
}

const MAX_BATCH_CLAIM_LIMIT = 10;

export function useUpdateWorkbench({
  open,
  owner,
  repo,
  edition,
  initialJobId,
  isLoggedIn,
  onJobResolved,
}: UseUpdateWorkbenchOptions) {
  const router = useRouter();

  const [activeJobId, setActiveJobId] = useState<string | null>(initialJobId ?? null);

  // 全仓任务列表与大纲树
  const [jobs, setJobs] = useState<RepoUpdateJobItem[]>([]);
  const [outline, setOutline] = useState<RelayOutlineChapter[]>([]);
  const [repoMeta, setRepoMeta] = useState<RelayRepoMeta | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  // 批量与单篇勾选/提交状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [claimingNodeId, setClaimingNodeId] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<RelaySuccessResult | null>(null);

  // 加载全景接力数据
  const loadData = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const editionQuery = edition ? `&edition=${encodeURIComponent(edition)}` : '';
      const data = await api.get<{
        repo?: RelayRepoMeta;
        outline?: RelayOutlineChapter[];
        jobs?: RepoUpdateJobItem[];
      }>(
        `/api/update/jobs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${editionQuery}`,
        { onUnauthorized: 'throw' }
      );

      const list: RepoUpdateJobItem[] = data.jobs || [];
      setJobs(list);

      if (data.repo) {
        setRepoMeta(data.repo);
      }

      if (data.outline && Array.isArray(data.outline) && data.outline.length > 0) {
        setOutline(data.outline);
      } else {
        // Fallback: 若后端大纲尚未就绪，通过 ingest-status 投影完整文档列表，确保 0 丢章
        try {
          const statusEditionQuery = edition ? `?edition=${encodeURIComponent(edition)}` : '';
          const statusData = await api.get<{
            repository?: { repoProfile?: { title?: string; description?: string } };
            documents?: Array<{ id: string; path: string; title: string | null; status: string }>;
          }>(`/api/ingest-status/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${statusEditionQuery}`);

          if (statusData.documents && statusData.documents.length > 0) {
            const jobMap = new Map<string, RepoUpdateJobItem>();
            list.forEach((j) => {
              if (j.documentId) jobMap.set(j.documentId, j);
              if (j.path) jobMap.set(j.path, j);
            });

            const nodes: RelayOutlineNode[] = statusData.documents.map((doc) => {
              const matchedJob = jobMap.get(doc.id) || jobMap.get(doc.path);
              let status: 'PROCESSED' | 'CLAIMED' | 'UNPROCESSED' = 'UNPROCESSED';
              if (doc.status === 'PROCESSED') status = 'PROCESSED';
              else if (matchedJob?.status === 'CLAIMED') status = 'CLAIMED';
              else if (matchedJob?.status === 'SWAPPED') status = 'PROCESSED';

              return {
                id: doc.id,
                documentId: doc.id,
                title: doc.title || doc.path.split('/').pop()?.replace(/\.mdx?$/, '') || doc.path,
                path: doc.path,
                status,
                versionCount: status === 'PROCESSED' ? 1 : 0,
                claimedBy: matchedJob?.claimedBy ?? null,
                jobId: matchedJob?.id ?? null,
              };
            });

            setOutline([
              {
                id: 'full-outline',
                title: m.relay_outline_full(),
                nodes,
              },
            ]);
          } else if (list.length > 0) {
            setOutline([
              {
                id: 'jobs-outline',
                title: m.relay_active_tasks(),
                nodes: list.map((j) => ({
                  id: j.documentId || j.id,
                  documentId: j.documentId || j.id,
                  title: j.document?.title || j.path,
                  path: j.path,
                  status: j.status === 'CLAIMED' ? 'CLAIMED' : j.status === 'SWAPPED' ? 'PROCESSED' : 'UNPROCESSED',
                  versionCount: 1,
                  claimedBy: j.claimedBy,
                  jobId: j.id,
                })),
              },
            ]);
          }
        } catch {
          if (list.length > 0) {
            setOutline([
              {
                id: 'jobs-outline',
                title: m.relay_active_tasks(),
                nodes: list.map((j) => ({
                  id: j.documentId || j.id,
                  documentId: j.documentId || j.id,
                  title: j.document?.title || j.path,
                  path: j.path,
                  status: j.status === 'CLAIMED' ? 'CLAIMED' : j.status === 'SWAPPED' ? 'PROCESSED' : 'UNPROCESSED',
                  versionCount: 1,
                  claimedBy: j.claimedBy,
                  jobId: j.id,
                })),
              },
            ]);
          }
        }
      }
    } catch {
      toastManager.add({
        type: 'warning',
        title: m.update_load_jobs_failed_title(),
        description: m.update_load_jobs_failed_desc(),
      });
    } finally {
      setLoadingJobs(false);
    }
  }, [owner, repo, edition]);

  // 打开弹窗自动刷新数据；关闭时若有在途任务保留任务胶囊态
  useEffect(() => {
    const currentTask = useRelayTaskStore.getState().activeTask;
    const isSameRepoRunning =
      Boolean(currentTask) &&
      currentTask?.status === 'running' &&
      currentTask.owner === owner &&
      currentTask.repo === repo;

    if (!open) {
      setSelectedIds(new Set());
      setClaimingNodeId(isSameRepoRunning ? (currentTask?.nodeId ?? null) : null);
      return;
    }

    setClaimingNodeId(isSameRepoRunning ? (currentTask?.nodeId ?? null) : null);
    setSuccessResult(null);
    setActiveJobId(initialJobId ?? null);
    if (initialJobId) {
      setSelectedIds(new Set([initialJobId]));
    }
    void loadData();
  }, [open, initialJobId, loadData, owner, repo]);

  // 状态对齐轮询（性能修复 2026-10-13 随批量认领异步化）：batch-claim 现在
  // 认领后立即返回、转录在服务端异步推进——工作台在大纲存在 CLAIMED 节点期间
  // 每 15s 静默对齐一次（页面隐藏暂停；全部离开 CLAIMED 态即自动停止）。
  const hasClaimedNodes = useMemo(
    () => outline.some((ch) => ch.nodes.some((n) => n.status === 'CLAIMED')),
    [outline]
  );
  useEffect(() => {
    if (!open || !hasClaimedNodes) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadData();
    }, 15_000);
    return () => clearInterval(timer);
  }, [open, hasClaimedNodes, loadData]);

  // 统计可认领与状态计数
  const claimableNodes = useMemo(() => {
    return outline.flatMap((ch) => ch.nodes).filter((n) => n.status === 'UNPROCESSED');
  }, [outline]);

  // 大纲刷新后自动剪除已失效的勾选
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(claimableNodes.map((n) => n.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [claimableNodes]);

  const allSelected = claimableNodes.length > 0 && claimableNodes.every((n) => selectedIds.has(n.id));

  const toggleSelect = (nodeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else {
        if (next.size >= MAX_BATCH_CLAIM_LIMIT) {
          toastManager.add({
            type: 'info',
            title: `单次最多选择 ${MAX_BATCH_CLAIM_LIMIT} 个章节`,
          });
          return prev;
        }
        next.add(nodeId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(claimableNodes.slice(0, MAX_BATCH_CLAIM_LIMIT).map((n) => n.id)));
      if (claimableNodes.length > MAX_BATCH_CLAIM_LIMIT) {
        toastManager.add({
          type: 'info',
          title: `已为你选取前 ${MAX_BATCH_CLAIM_LIMIT} 个待转录章节`,
        });
      }
    }
  };

  // 监听后台接力任务状态（仅当当前仓库在途任务从 running 跃迁至 completed/failed 时触发）
  useEffect(() => {
    const unsub = useRelayTaskStore.subscribe((state, prevState) => {
      const task = state.activeTask;
      const prevTask = prevState.activeTask;
      if (!task || task.owner !== owner || task.repo !== repo) return;

      if (prevTask?.status === 'running' && task.status === 'completed' && task.result) {
        setSuccessResult(task.result);
        setClaimingNodeId(null);
        void loadData();
      } else if (prevTask?.status === 'running' && task.status === 'failed') {
        setClaimingNodeId(null);
      }
    });
    return () => unsub();
  }, [loadData, owner, repo]);

  // 单篇认领转录
  const doSingleClaim = async (node: RelayOutlineNode) => {
    if (!isLoggedIn) {
      toastManager.add({
        type: 'info',
        title: m.toast_login_required(),
        description: m.toast_login_required_desc(),
      });
      return;
    }
    const targetId = node.jobId || node.documentId || node.id;
    setClaimingNodeId(node.id);
    useRelayTaskStore.getState().startTask({
      owner,
      repo,
      nodeId: node.id,
      path: node.path,
      title: node.title,
    });
    try {
      const res = await api.post<{
        frozenCredits: number;
        durationSeconds: number;
        tokensUsed: number;
        model: string;
        path?: string;
        title?: string;
        chapterTitle?: string | null;
        owner?: string;
        repo?: string;
      }>(`/api/update/jobs/${targetId}/claim-transcribe`);

      const resultPayload: RelaySuccessResult = {
        nodeId: node.id,
        path: res.path || node.path,
        title: res.title || node.title,
        chapterTitle: res.chapterTitle || null,
        durationSeconds: res.durationSeconds || 1,
        tokensUsed: res.tokensUsed || 0,
        model: res.model || 'AI Model',
        frozenCredits: res.frozenCredits || 0,
        owner: res.owner || owner,
        repo: res.repo || repo,
      };

      useRelayTaskStore.getState().completeTask(resultPayload);
      setSuccessResult(resultPayload);
      void loadData();
      onJobResolved?.();
      router.refresh();
    } catch (err) {
      useRelayTaskStore.getState().failTask((err as Error)?.message || m.toast_transcription_failed());
      if (err instanceof ApiClientError && err.code === 'NO_MODEL') {
        toastManager.add({
          type: 'info',
          title: m.toast_missing_model_config(),
          description: m.toast_config_model_hint(),
        });
        return;
      }
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: (err as Error)?.message || m.common_retry_later(),
      });
    } finally {
      setClaimingNodeId(null);
    }
  };

  const handleSingleClaim = (node: RelayOutlineNode) => {
    if (claimingNodeId !== null || batchSubmitting) return;
    requireApiKey(() => void doSingleClaim(node), m.relay_continue_transcribe());
  };

  // 批量认领转录
  const doBatchClaim = async () => {
    if (!isLoggedIn) {
      toastManager.add({
        type: 'info',
        title: m.toast_login_required(),
        description: m.toast_login_required_desc(),
      });
      return;
    }
    if (selectedIds.size === 0) {
      toastManager.add({ type: 'info', title: m.update_select_chapters_title() });
      return;
    }
    setBatchSubmitting(true);
    try {
      const nodeMap = new Map<string, RelayOutlineNode>();
      outline.flatMap((ch) => ch.nodes).forEach((n) => nodeMap.set(n.id, n));

      const targetIds = Array.from(selectedIds).map((id) => {
        const node = nodeMap.get(id);
        return node ? (node.jobId || node.documentId || node.id) : id;
      });

      const res = await api.post<{ success: boolean; successCount: number; results?: unknown[] }>(
        '/api/update/jobs/batch-claim',
        { jobIds: targetIds }
      );

      if (res.success && res.successCount > 0) {
        toastManager.add({
          type: 'success',
          title: m.update_claim_success_title(),
          description: m.update_claim_success_desc({ count: res.successCount }),
        });
        setSelectedIds(new Set());
        void loadData();
        onJobResolved?.();
        router.refresh();
      } else {
        toastManager.add({
          type: 'warning',
          title: m.toast_action_failed(),
          description: m.common_retry_later(),
        });
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'NO_MODEL') {
        toastManager.add({
          type: 'info',
          title: m.toast_missing_model_config(),
          description: m.toast_config_model_hint(),
        });
        return;
      }
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: (err as Error)?.message || m.common_retry_later(),
      });
    } finally {
      setBatchSubmitting(false);
    }
  };

  const handleBatchClaim = () => {
    if (batchSubmitting || claimingNodeId !== null) return;
    requireApiKey(() => void doBatchClaim(), m.workbench_batch_claim());
  };

  // 统计概览
  const totalCount = useMemo(() => outline.flatMap((ch) => ch.nodes).length, [outline]);
  const processedCount = useMemo(
    () => outline.flatMap((ch) => ch.nodes).filter((n) => n.status === 'PROCESSED').length,
    [outline]
  );
  const inProgressCount = useMemo(
    () => outline.flatMap((ch) => ch.nodes).filter((n) => n.status === 'CLAIMED').length,
    [outline]
  );

  return {
    activeJobId,
    jobs,
    outline,
    repoMeta,
    loadingJobs,
    selectedIds,
    batchSubmitting,
    claimingNodeId,
    totalCount,
    processedCount,
    inProgressCount,
    claimableCount: claimableNodes.length,
    allSelected,
    toggleSelect,
    toggleSelectAll,
    handleSingleClaim,
    handleBatchClaim,
    successResult,
    setSuccessResult,
  };
}
