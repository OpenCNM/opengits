'use client';

import { useRef, useEffect, useCallback } from 'react';
import { toastManager } from '@/components/ui/toast';
import { STORAGE_KEYS, WEB_DOC_OWNER } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { cancelWizardTranslation } from './useWizardTranslation';
import { subscribeImportJob, type ImportJobSubscription } from '@/lib/jobs/import-job-subscription';
import {
  submitIngestRequest,
  isTierRepoLimitError,
  persistLastImportJob,
  type IngestJobResponse,
} from '@/lib/import-wizard/run-ingest-job';
import {
  useImportWizardStore,
  wizardSetters,
  createWizardResetPatch,
  wizardFlow,
  getWizardCloseAction,
} from '@/lib/stores/import-wizard-store';
import { requireApiKey, hasConfiguredApiKey } from '@/lib/api-key-guard';
import { safeGetJSON, safeRemove } from '@/lib/storage-utils';
import { canonicalizeOutline, clearWorkbenchDraft } from '@/lib/import-wizard/draft-storage';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import * as m from '@/paraglide/messages';
import { seedDockTutorial, syncDockTutorialFromFacts } from '@/lib/stores/dock-sync';
import { useTutorialDockStore } from '@/lib/stores/transcription-dock-store';
import { resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import type { WebDocScopeParams } from '@/lib/schemas/webdoc-topology';

/** web-doc 提交参数（含确认页作用域；scope 缺省 = 自动裁决兜底） */
export interface WebDocSubmitParams {
  maxPages: number;
  isPublic: boolean;
  scope?: WebDocScopeParams;
}

export function useWizardIngestSubmission(locale?: string) {
  // 细粒度原子订阅：仅订阅弹窗打开状态，避免表单打字或选项变更时引发该流程 Hook 全量重渲染
  const isOpen = useImportWizardStore((s) => s.isOpen);

  const {
    setIsOpen,
    setStep,
    setUrl,
    setCreateEdition,
    setLogs,
    setIngestFailed,
    setIngestSuccessInfo,
    setShowConfirmCloseDialog,
    setShowIngestAbortDialog,
    setEmptyCategoriesCount,
    setShowEmptyCategoryDialog,
    setIsSubmitting,
    setSubmittedJobId,
  } = wizardSetters;

  const streamAliveRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const jobSubRef = useRef<ImportJobSubscription | null>(null);
  const lastWebDocParamsRef = useRef<WebDocSubmitParams | null>(null);

  // 组件卸载时物理切断正在进行的 SSE/轮询订阅与网络请求，杜绝后台幽灵连接与闭包残留
  useEffect(() => {
    return () => {
      jobSubRef.current?.stop();
      jobSubRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const resetWizard = useCallback(() => {
    setShowConfirmCloseDialog(false);
    setShowIngestAbortDialog(false);
    cancelWizardTranslation();
    const midStream = streamAliveRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const { step, ingestSuccessInfo, submittedJobId, repoPreExisted, scoutData } = useImportWizardStore.getState();
    if (
      step === 3 &&
      !ingestSuccessInfo &&
      !submittedJobId &&
      !midStream &&
      !repoPreExisted &&
      scoutData?.owner &&
      scoutData?.repo
    ) {
      fetch(
        `/api/repos?owner=${encodeURIComponent(scoutData.owner)}&repo=${encodeURIComponent(
          scoutData.repo
        )}&global=true`,
        {
          method: 'DELETE',
        }
      ).catch(() => {});
    }

    useImportWizardStore.setState(createWizardResetPatch(locale));
  }, [locale, setShowConfirmCloseDialog, setShowIngestAbortDialog]);

  const openWizard = useCallback(() => {
    const { isOpen, step, submittedJobId } = useImportWizardStore.getState();
    if (!isOpen && !submittedJobId && step !== 1) {
      resetWizard();
    }
    setStep(1);
    setIsOpen(true);
  }, [setIsOpen, setStep, resetWizard]);

  const openWizardForEdition = useCallback((owner: string, repo: string) => {
    // web-docs 为站内网页文档快照虚拟命名空间，不支持 GitHub 仓库多讲法转录
    if (owner.toLowerCase() === WEB_DOC_OWNER) return;
    setUrl(`https://github.com/${owner}/${repo}`);
    setCreateEdition(true);
    wizardFlow.openAtInput();
  }, [setCreateEdition, setUrl]);

  const handleCloseRequest = () => {
    // 关闭守卫收敛为单一纯投影决策（裸字段三连判已下沉到 projectWizardCloseAction）
    const action = getWizardCloseAction(useImportWizardStore.getState());
    if (action === 'confirm-dirty') {
      setShowConfirmCloseDialog(true);
      return;
    }
    if (action === 'confirm-abort') {
      setShowIngestAbortDialog(true);
      return;
    }
    resetWizard();
  };

  const followImportJob = (
    jobId: string,
    meta: { owner: string; repo: string; landingPath?: string; edition?: string; mode?: 'github' | 'web' }
  ) => {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const isWebMode = meta.mode === 'web' || meta.owner === WEB_DOC_OWNER;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        streamAliveRef.current = false;
        setLogs((prev) => [...prev, 'Ingestion pipeline completed successfully.']);
        setIngestSuccessInfo({
          owner: meta.owner,
          repo: meta.repo,
          landingPath: meta.landingPath,
          edition: meta.edition,
        });
        if (isWebMode) {
          const existingDock = useTutorialDockStore.getState().getTutorial(`${meta.owner}/${meta.repo}`);
          if (existingDock) {
            syncDockTutorialFromFacts(existingDock, {
              dockStatus: 'PROCESSED',
              completedChapters: existingDock.totalChapters > 0 ? existingDock.totalChapters : 1,
              totalChapters: existingDock.totalChapters > 0 ? existingDock.totalChapters : 1,
              activeChapterTitle: null,
              activeDocPath: null,
            });
          }
        }
        toastManager.add({
          type: 'success',
          title: isWebMode ? m.import_ingest_web_success_title() : m.import_ingest_success_title(),
          description: isWebMode ? m.import_ingest_web_success_desc() : m.import_ingest_success_desc(),
        });
        resolve();
      };
      const finishErr = (message: string) => {
        if (settled) return;
        settled = true;
        streamAliveRef.current = false;
        reject(new Error(message));
      };
      const finishAbort = () => {
        if (settled) return;
        settled = true;
        streamAliveRef.current = false;
        const err = new Error(m.import_job_aborted());
        err.name = 'AbortError';
        reject(err);
      };

      jobSubRef.current?.stop();
      jobSubRef.current = subscribeImportJob(
        jobId,
        {
          onEvent: (data) => {
            if (data.type === 'log') {
              setLogs((prev) => {
                const msg = String(data.message ?? '');
                if (prev.length >= 500) {
                  return [...prev.slice(-499), msg];
                }
                return [...prev, msg];
              });
            } else if (data.type === 'progress') {
              const speed = String(data.speedFormatted || data.speed || '');
              const percent = typeof data.percent === 'number' ? data.percent.toFixed(1) : '';
              const file = String(data.currentFile || '');
              const prefix = m.import_stage_loading_archive();
              const msg = data.message
                ? String(data.message)
                : `${prefix} ${speed}${percent ? ` (${percent}%)` : ''}${file && file !== 'cached' ? ` · ${file}` : ''}`;
              setLogs((prev) => {
                if (prev.length > 0 && (prev[prev.length - 1].startsWith(prefix) || prev[prev.length - 1].startsWith('[2/5] 装载归档:'))) {
                  const copy = [...prev];
                  copy[copy.length - 1] = msg;
                  return copy;
                }
                if (prev.length >= 500) {
                  return [...prev.slice(-499), msg];
                }
                return [...prev, msg];
              });
            } else if (data.type === 'done') {
              finishOk();
            } else if (data.type === 'error') {
              finishErr(String(data.message || m.import_job_backend_failed()));
            }
          },
          onClose: (reason) => {
            if (reason === 'aborted') finishAbort();
            else if (reason === 'gone') finishErr(m.import_job_gone());
          },
        },
        abortControllerRef.current?.signal
      );
    });
  };

  // Phase B resume: connect to running import job if present on dialog open
  useEffect(() => {
    if (!isOpen) return;
    const saved = safeGetJSON<{ jobId: string; owner: string; repo: string } | null>(
      STORAGE_KEYS.LAST_IMPORT_JOB,
      null
    );
    if (!saved?.jobId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/ingest-jobs/${saved.jobId}?since=-1`, { cache: 'no-store' });
        if (!res.ok) {
          safeRemove(STORAGE_KEYS.LAST_IMPORT_JOB);
          return;
        }
        const snapshot = await res.json();
        const status: string | undefined = snapshot?.job?.status;
        if (status === 'QUEUED' || status === 'RUNNING') {
          if (cancelled) return;
          setStep(3);
          setIngestFailed(false);
          streamAliveRef.current = true;
          abortControllerRef.current = new AbortController();
          setLogs((prev) => [
            ...prev,
            m.ingest_resume_running_job({ repo: `${saved.owner}/${saved.repo}` }),
          ]);
          await followImportJob(saved.jobId, {
            owner: saved.owner,
            repo: saved.repo,
            mode: saved.owner === WEB_DOC_OWNER ? 'web' : 'github',
          });
        } else {
          safeRemove(STORAGE_KEYS.LAST_IMPORT_JOB);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const executeIngestion = async (overrideParams?: {
    outline?: any[];
  }) => {
    if (!hasConfiguredApiKey()) {
      requireApiKey(() => {
        executeIngestion(overrideParams);
      }, m.apikey_continue_transcribe());
      return;
    }

    const {
      url,
      scoutData,
      targetLanguage,
      customPrompt,
      transcriptionPreset,
      aiCondensation,
      teachingDepth,
      category,
      customOutline,
      importScopeMode,
      targetLandingPath,
      selectedPrefix,
      menuStyle,
      createEdition,
      editionLabel,
      isPublic,
      selectedTags,
      versionLabel,
      customExtensions,
      draftOutline,
    } = useImportWizardStore.getState();

    setStep(3);
    setIsSubmitting(true);
    setSubmittedJobId(null);
    setLogs([]);
    setIngestFailed(false);
    streamAliveRef.current = true;

    try {
      if (
        scoutData?.owner &&
        scoutData?.repo &&
        typeof window !== 'undefined' &&
        window.localStorage
      ) {
        window.localStorage.setItem(
          `ingest-config-${scoutData.owner}/${scoutData.repo}`,
          JSON.stringify({
            targetLanguage,
            customPrompt,
            transcriptionPreset,
            aiCondensation,
            teachingDepth,
          })
        );
      }
    } catch {}

    try {
      const finalCategoryName = (category && category !== 'custom') ? category : 'Others';
      const rawOutline = overrideParams?.outline || customOutline;
      const effectiveOutline = canonicalizeOutline(rawOutline);
      const effectivePrefixFilter =
        importScopeMode === 'single_doc' && targetLandingPath
          ? targetLandingPath
          : selectedPrefix;

      if (abortControllerRef.current) abortControllerRef.current.abort();
      abortControllerRef.current = new AbortController();

      const userProviders = useModelProviderStore.getState().userProviders;
      const configuredProviders = userProviders.filter(
        (p) => Boolean(p.hasApiKey || p.apiKey) && p.models.length > 0
      );
      const activeProvider =
        configuredProviders.find((p) => p.isActive) || configuredProviders[0];
      const activeModel =
        activeProvider?.selectedModel || activeProvider?.models[0] || '';

      const basePayload = {
        owner: scoutData?.owner,
        repo: scoutData?.repo,
        repoUrl: url,
        branch: scoutData?.branch || ENGINE_CONFIG.defaultBranch,
        prefixFilter: effectivePrefixFilter,
        prefix: selectedPrefix,
        useAi: menuStyle === 'ai',
        menuStyle: menuStyle,
        targetLanguage,
        customPrompt,
        transcriptionPreset,
        model: activeModel || undefined,
        transcriptionModel: activeModel || undefined,
        createEdition,
        editionLabel: editionLabel?.trim() || undefined,
        aiCondensation,
        teachingDepth,
        isPublic,
        category: finalCategoryName,
        tags: selectedTags,
        customOutline: effectiveOutline,
        versionLabel,
        customExtensions,
        starCount: scoutData?.starCount,
        profile: scoutData?.profile,
        versions: scoutData?.versions,
        currentSha: scoutData?.currentSha,
        draftOutline,
      };

      const submitOne = async (overrides: Record<string, unknown>): Promise<IngestJobResponse> => {
        try {
          return await submitIngestRequest('/api/ingest', { ...basePayload, ...overrides }, {
            signal: abortControllerRef.current!.signal,
          });
        } catch (err) {
          if (isTierRepoLimitError(err)) {
            throw new Error(err.message || m.import_repo_limit_reached());
          }
          throw err;
        }
      };

      // 统一单教程导入（巨型仓按篇章分层收敛，杜绝伪切片与并发锁竞争）
      const created: IngestJobResponse = await submitOne({});

      if (!created?.jobId) {
        throw new Error(m.import_ingest_no_job_id({ status: 202 }));
      }

      // 任务成功入库，向导进入 HANDOFF 终态并原子清理解析态草稿
      // 已知接缝（刻意接受）：handoffToIngest 与下方 dock 种子写入是跨两个 store 的
      // 两次写，非原子——两写之间标签页崩溃会留下「服务端有 Job、Dock 不显示」的窗口；
      // 任务仍在服务端正常执行，重新打开向导会经 LAST_IMPORT_JOB 恢复跟踪
      wizardFlow.handoffToIngest(created.jobId);
      if (scoutData?.owner && scoutData?.repo) {
        clearWorkbenchDraft(scoutData.owner, scoutData.repo);
      }

      const resolvedEdition = (created as any).edition || '';
      persistLastImportJob({
        jobId: created.jobId,
        owner: scoutData?.owner || 'owner',
        repo: scoutData?.repo || 'repo',
        edition: resolvedEdition,
      });

      // 派发至全局转录任务跟踪 Dock（状态机物理隔离，不漏锁与干扰阅读态）
      const tutOwner = scoutData?.owner || 'owner';
      const tutRepo = scoutData?.repo || 'repo';
      const tutEdition = resolvedEdition || null;
      const dockId = tutEdition ? `${tutOwner}/${tutRepo}:${tutEdition}` : `${tutOwner}/${tutRepo}`;
      const totalChapters = effectiveOutline.reduce((sum: number, cat: any) => sum + (cat.files?.length || 0), 0);
      seedDockTutorial({
        id: dockId,
        owner: tutOwner,
        repo: tutRepo,
        edition: tutEdition,
        title: resolveRepositoryDisplayName({ owner: tutOwner, repo: tutRepo, repoProfile: scoutData?.profile }) || tutRepo,
        url: `/docs/${tutOwner}/${tutRepo}${tutEdition ? `?edition=${encodeURIComponent(tutEdition)}` : ''}`,
        status: 'QUEUED',
        startedAt: Date.now(),
        completedChapters: 0,
        totalChapters: totalChapters > 0 ? totalChapters : 1,
        updatedAt: Date.now(),
      });

      await followImportJob(created.jobId, {
        owner: scoutData?.owner || 'owner',
        repo: scoutData?.repo || 'repo',
        landingPath: targetLandingPath || undefined,
        edition: resolvedEdition || undefined,
      });
    } catch (e: any) {
      streamAliveRef.current = false;
      setIsSubmitting(false);
      setLogs((prev) => [...prev, `[ERROR] ${e.message}`]);
      toastManager.add({ type: 'error', title: m.import_failed_title(), description: e.message });
      if (e?.name !== 'AbortError') {
        setIngestFailed(true);
      }
    }

  };

  const handleIngest = async () => {
    return executeIngestion();
  };

  const submitWebDocImport = async (params: WebDocSubmitParams) => {
    const { url } = useImportWizardStore.getState();
    if (!url) return;
    lastWebDocParamsRef.current = params;
    if (!hasConfiguredApiKey()) {
      requireApiKey(() => {
        submitWebDocImport(params);
      }, m.apikey_continue_import());
      return;
    }

    setStep(3);
    setIsSubmitting(true);
    setSubmittedJobId(null);
    setLogs([]);
    setIngestFailed(false);
    streamAliveRef.current = true;

    const jobOwner = WEB_DOC_OWNER;
    let jobRepo = '';
    try {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      abortControllerRef.current = new AbortController();

      let created: {
        reused?: boolean;
        repositoryId?: string;
        owner?: string;
        repo?: string;
        jobId?: string;
      };
      try {
        created = await submitIngestRequest(
          '/api/ingest/web-doc',
          {
            url,
            maxPages: params.maxPages,
            isPublic: params.isPublic,
            ...(params.scope ?? { scopeMode: '', primaryDocPrefix: '', allowedPrefixes: [], moduleTabs: [] }),
          },
          { signal: abortControllerRef.current.signal }
        );
      } catch (err) {
        if (isTierRepoLimitError(err)) {
          throw new Error(err.message || m.import_repo_limit_reached());
        }
        throw err;
      }

      if (created?.reused) {
        streamAliveRef.current = false;
        setIsSubmitting(false);
        setIngestSuccessInfo({ owner: 'web-docs', repo: created.repo || '' });
        toastManager.add({
          type: 'success',
          title: m.import_doclib_ready_title(),
          description: m.import_doclib_ready_desc(),
        });
        return;
      }

      if (!created?.jobId) {
        throw new Error(m.import_ingest_no_job_id({ status: 202 }));
      }

      try {
        const u = new URL(url);
        jobRepo = u.hostname.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      } catch {}

      wizardFlow.handoffToIngest(created.jobId);
      persistLastImportJob({
        jobId: created.jobId,
        owner: jobOwner,
        repo: jobRepo,
      });

      seedDockTutorial({
        id: `${jobOwner}/${jobRepo}`,
        owner: jobOwner,
        repo: jobRepo,
        edition: null,
        title: jobRepo,
        url: `/docs/${jobOwner}/${jobRepo}`,
        status: 'QUEUED',
        startedAt: Date.now(),
        completedChapters: 0,
        totalChapters: 1,
        updatedAt: Date.now(),
      });

      await followImportJob(created.jobId, { owner: jobOwner, repo: jobRepo, mode: 'web' });
    } catch (e: any) {
      streamAliveRef.current = false;
      setIsSubmitting(false);
      setLogs((prev) => [...prev, `[ERROR] ${e.message}`]);
      toastManager.add({ type: 'error', title: m.import_failed_title(), description: e.message });
      if (e?.name !== 'AbortError') {
        setIngestFailed(true);
      }
    }

  };

  const retryWebDocImport = async () => {
    const last = lastWebDocParamsRef.current;
    if (!last) {
      wizardFlow.goToStepWithSubStep(1, 'web_confirm');
      return;
    }
    await submitWebDocImport(last);
  };

  const validateOutline = () => {
    const { customOutline } = useImportWizardStore.getState();
    if (!customOutline || customOutline.length === 0) {
      toastManager.add({
        type: 'warning',
        title: m.import_outline_empty_title(),
        description: m.import_outline_empty_desc(),
      });
      return false;
    }
    if (customOutline.some((cat) => !cat.name || !cat.name.trim())) {
      toastManager.add({
        type: 'warning',
        title: m.import_chapter_name_empty_title(),
        description: m.import_chapter_name_empty_desc(),
      });
      return false;
    }

    const emptyCats = customOutline.filter((cat) => !cat.files || cat.files.length === 0);
    if (emptyCats.length > 0) {
      setEmptyCategoriesCount(emptyCats.length);
      setShowEmptyCategoryDialog(true);
      return false;
    }

    const totalFiles = customOutline.reduce((sum, cat) => sum + (cat.files?.length || 0), 0);
    if (totalFiles === 0) {
      toastManager.add({
        type: 'warning',
        title: m.import_outline_empty_title(),
        description: m.import_outline_empty_desc(),
      });
      return false;
    }

    return true;
  };

  return {
    openWizard,
    openWizardForEdition,
    handleCloseRequest,
    resetWizard,
    executeIngestion,
    handleIngest,
    submitWebDocImport,
    retryWebDocImport,
    validateOutline,
  };
}
