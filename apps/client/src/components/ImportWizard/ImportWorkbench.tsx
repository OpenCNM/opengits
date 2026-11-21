'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, FolderTree, Gauge, Globe, Loader2, Sparkles, WifiOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ENGINE_CONFIG } from '@/lib/config';
import { SUPPORTED_LANGUAGES, resolveGenerativeLanguage } from '@/lib/constants';
import { getLocale } from '@/paraglide/runtime.js';
import { useImportWizardStore, wizardFlow, wizardSetters } from '@/lib/stores/import-wizard-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { useImportWizard } from './ImportWizardContext';
import { useImportJourneyTracker } from '@/hooks/useImportJourneyTracker';
import { mergeTreeCoursesToSingleOutline } from '@/engine/tree-batch-utils';
import { trackEvent } from '@/lib/telemetry/beacon';
import { buildImportedTutorialHref } from '@/lib/import-wizard/navigation';
import { WorkbenchOutlineEditor } from './workbench/WorkbenchOutlineEditor';
import { WorkbenchReorganizeBar } from './workbench/WorkbenchReorganizeBar';
import { type LearnerArchetype, type ReorganizeOptions } from './workbench/workbench-reorganize-config';
import { WorkbenchStep3Executing } from './workbench/WorkbenchStep3Executing';
import { WorkbenchTranscriptionSettings } from './workbench/WorkbenchTranscriptionSettings';
import { WizardModelBadge } from './common/WizardModelSelector';
import { useWorkbenchDraft } from './hooks/useWorkbenchDraft';
import * as m from '@/paraglide/messages';

/** 静默超时守卫（45s）：仅当超过 45s 未收到任何 step 推进或 ping 心跳时，才判定为网络假死并回退 */
const INACTIVITY_TIMEOUT_MS = 45_000;

/** 冷启动准备轮询上限（45 × 8s ≈ 6 分钟）：巨仓后台下载归档+建图的
 * 有界等待，超出后给出可行动错误而非无限空转 */
const PREP_POLL_MAX = 45;

export function ImportWorkbench() {
  const isOpen = useImportWizardStore((s) => s.isOpen);
  const step = useImportWizardStore((s) => s.step);
  const subStep = useImportWizardStore((s) => s.subStep);
  const url = useImportWizardStore((s) => s.url);
  const loading = useImportWizardStore((s) => s.loading);
  const prefixLoading = useImportWizardStore((s) => s.prefixLoading);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const ingestSuccessInfo = useImportWizardStore((s) => s.ingestSuccessInfo);
  const ingestFailed = useImportWizardStore((s) => s.ingestFailed);
  const scoutError = useImportWizardStore((s) => s.scoutError);
  const draftOutline = useImportWizardStore((s) => s.draftOutline);
  const draftLoading = useImportWizardStore((s) => s.draftLoading);
  const isGiantScope = useImportWizardStore((s) => s.isGiantScope);
  const selectedPrefix = useImportWizardStore((s) => s.selectedPrefix);
  const targetLanguage = useImportWizardStore((s) => s.targetLanguage);
  // 大纲/规则兜底是生成型内容:`none`(不翻译)只约束文档转录,此处确定性回落到界面 locale
  const generativeLanguage = resolveGenerativeLanguage(targetLanguage as string, getLocale());
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const importMode = useImportWizardStore((s) => s.importMode);
  const excludedPaths = useImportWizardStore((s) => s.excludedPaths);
  const customPrompt = useImportWizardStore((s) => s.customPrompt);
  const teachingDepth = useImportWizardStore((s) => s.teachingDepth);

  const { setStep, setSubStep } = wizardSetters;

  const {
    handleIngest,
    validateOutline,
    resetWizard,
    retryWebDocImport,
    handleCloseRequest,
  } = useImportWizard();

  const {
    hasRecoverableDraft,
    recoverableDraftTimeText,
    handleRecoverDraft,
    handleDiscardDraft,
  } = useWorkbenchDraft();

  const router = useRouter();

  useImportJourneyTracker({
    isOpen,
    step,
    subStep,
    url,
    loading,
    prefixLoading,
    scoutData,
    ingestSuccessInfo,
    ingestFailed,
    scoutError,
  });

  const isExecuting = step === 3;

  const [isGeneratingOutline, setIsGeneratingOutline] = useState(false);
  const [hasCompletedGen, setHasCompletedGen] = useState(false);
  const [rateLimitRetrying, setRateLimitRetrying] = useState(false);
  const [prepHint, setPrepHint] = useState<string | null>(null);
  const [outlineGenError, setOutlineGenError] = useState<string | null>(null);
  const [outlineGenErrorCode, setOutlineGenErrorCode] = useState<string | null>(null);
  /** 探查配额档位 0-3：用户「更深入/更浅」反馈式控制（判断权归用户、预算权归代码） */
  const [rollupLevel, setRollupLevel] = useState(0);
  /** 本次大纲的路由深度（1=小仓骨架全可见无 rollup；2=巨仓下钻——控件仅此态显示） */
  const [outlineDepth, setOutlineDepth] = useState<1 | 2 | undefined>(undefined);
  /** 上一次响应的 needRollupCapped（点击埋点用，ref 不触发渲染） */
  const rollupCappedRef = useRef(false);
  const [technicalDetail, setTechnicalDetail] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const triggeredKeyRef = useRef<string>('');
  const activeReqIdRef = useRef<number>(0);
  const currentKeyRef = useRef<string>('');
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isGeneratingRef = useRef(false);
  isGeneratingRef.current = isGeneratingOutline;

  // 步骤 2 启动与上下文对齐：当进入步骤 2 或检测到目标仓/版本/目录变更时，彻底初始化推导状态
  const currentTargetKey = `${scoutData?.owner || ''}/${scoutData?.repo || ''}@${(scoutData?.currentSha as string) || (scoutData?.branch as string) || 'HEAD'}@${selectedPrefix || '/'}`;
  useEffect(() => {
    if (step === 2 && currentKeyRef.current !== currentTargetKey) {
      currentKeyRef.current = currentTargetKey;
      triggeredKeyRef.current = '';
      setIsGeneratingOutline(false);
      setHasCompletedGen(false);
      setRateLimitRetrying(false);
      setOutlineGenError(null);
      setTechnicalDetail(null);
      setRollupLevel(0);
      setOutlineDepth(undefined);
      rollupCappedRef.current = false;
      wizardSetters.setOutlineGenError(null);
    }
  }, [step, currentTargetKey]);

  const parseOutlineError = useCallback((rawError: unknown, offline?: boolean): { message: string; detail?: string; code?: string } => {
    if (offline) {
      return {
        message: m.import_outline_network_offline_desc(),
      };
    }
    const msg = String((rawError as any)?.message || rawError || '');
    // 密钥类配置故障（2026-11 A 类收口最后一跳）：结构化 code 优先，
    // message 网关码前缀兜底（旧 sidecar 无 code 字段）——引导重配而非裸堆栈
    const keyCode =
      (rawError as any)?.code === 'KEY_DECRYPT_FAILED' || (rawError as any)?.code === 'MISSING_API_KEY'
        ? (rawError as any).code
        : /llm-gateway (KEY_DECRYPT_FAILED|MISSING_API_KEY):/.exec(msg)?.[1];
    if (keyCode === 'KEY_DECRYPT_FAILED' || keyCode === 'MISSING_API_KEY') {
      return {
        message: keyCode === 'KEY_DECRYPT_FAILED' ? m.toast_key_decrypt_failed() : m.toast_missing_api_key(),
        detail: keyCode,
        code: keyCode,
      };
    }
    if (/Failed to fetch|NetworkError|net::ERR_|ENOTFOUND|ECONNREFUSED|aborted/i.test(msg)) {
      return {
        message: m.import_outline_error_desc(),
        detail: msg.slice(0, 120),
      };
    }
    if (/HTTP 500|INTERNAL_ERROR|Internal Server Error/i.test(msg)) {
      return {
        message: m.import_outline_error_desc(),
        detail: 'HTTP 500: INTERNAL_ERROR',
      };
    }
    if (/HTTP 504|Gateway Timeout/i.test(msg)) {
      return {
        message: m.import_outline_error_desc(),
        detail: 'HTTP 504: Gateway Timeout',
      };
    }
    if (/HTTP 502|Bad Gateway/i.test(msg)) {
      return {
        message: m.import_outline_error_desc(),
        detail: 'HTTP 502: Bad Gateway',
      };
    }
    return {
      message: msg || m.import_outline_error_desc(),
    };
  }, []);

  // 离线/在线状态监听
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setIsOffline(!navigator.onLine);

    const handleOnline = () => {
      setIsOffline(false);
    };

    const handleOffline = () => {
      setIsOffline(true);
      if (isGeneratingRef.current) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        const offlineInfo = parseOutlineError(null, true);
        setOutlineGenError(offlineInfo.message);
        setTechnicalDetail(null);
        wizardSetters.setOutlineGenError(offlineInfo.message);
        setIsGeneratingOutline(false);
        wizardSetters.setDraftLoading(false);
        setHasCompletedGen(true);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [parseOutlineError]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // 卸载即完全复位触发闸：abort 后 finally 的闸门复位是异步微任务，
      // 晚于 StrictMode 重挂载的同步 effect 重跑——不在此复位会挡住补发，
      // 落入"请求被中断"死态（真实卸载时组件销毁，复位无副作用）
      triggeredKeyRef.current = '';
    };
  }, []);

  const handleRestart = useCallback(() => {
    activeReqIdRef.current++;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    setOutlineGenError(null);
    setPrepHint(null);
    setTechnicalDetail(null);
    wizardSetters.setOutlineGenError(null);
    setIsGeneratingOutline(false);
    wizardSetters.setDraftLoading(false);
    setHasCompletedGen(false);
    setRollupLevel(0);
    setOutlineDepth(undefined);
    rollupCappedRef.current = false;
    triggeredKeyRef.current = '';
    currentKeyRef.current = '';
    wizardFlow.goBackToScope();
  }, []);

  // 领域/标签分类懒取（非关键路径，fire-and-forget）：大纲已先行呈现，分类
  // 晚到预填 MetadataBar（其预填守卫保证用户手动选择优先）；reqId 变化丢弃
  // 过期响应。思考类模型分类可达分钟级，绝不允许它阻塞大纲呈现（CDC）。
  const fetchRepoMetadata = useCallback(
    async (
      chapters: Array<{ name?: string; summary?: string; files?: Array<{ path?: string } | string> }>,
      stats: { files?: number; allFiles?: number } | undefined,
      reqId: number
    ) => {
      if (!scoutData?.owner || !scoutData?.repo) return;
      try {
        const res = await fetch('/api/scout/repo-metadata', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner: scoutData.owner,
            repo: scoutData.repo,
            // CDC：只送分类决策所需证据（章名/摘要/路径采样），不带整份大纲
            chapters: chapters.map((ch) => ({
              name: ch.name,
              summary: ch.summary,
              files: (ch.files ?? []).slice(0, 8).map((f) => (typeof f === 'string' ? f : { path: f.path })),
            })),
            stats,
          }),
        });
        if (!res.ok) return;
        const json = await res.json();
        if (activeReqIdRef.current !== reqId) return;
        const metadata = (
          (json.data ?? json) as { metadata?: { category?: string; tags?: string[] } | null }
        )?.metadata;
        if (metadata?.category) {
          const prev = (useImportWizardStore.getState().draftOutline ?? {}) as Record<string, unknown>;
          wizardSetters.setDraftOutline({ ...prev, category: metadata.category, tags: metadata.tags ?? [] });
        }
      } catch {
        // fail-open：维持 Others 兜底
      }
    },
    [scoutData?.owner, scoutData?.repo]
  );

  const generateTreeOutline = useCallback(async (options?: {
    customPrompt?: string;
    pacing?: 'compact' | 'normal' | 'detailed';
    learnerArchetype?: LearnerArchetype;
    retryCount?: number;
    /** 冷启动准备轮询序号（巨仓后台下载建图的有界轮询，独立于限流 retryCount） */
    prepPoll?: number;
    /** 显式重试标识：清空前序失败并强制重新点火准备管线 */
    retry?: boolean;
    /** 探查配额档位 0-3；缺省继承当前 rollupLevel（重编排/重配 Key 等入口不静默退档） */
    rollupLevel?: number;
  }) => {
    if (!scoutData?.owner || !scoutData?.repo) {
      const errMsg = m.import_outline_error_desc();
      setOutlineGenError(errMsg);
      wizardSetters.setOutlineGenError(errMsg);
      setHasCompletedGen(true);
      return;
    }
    const sha = (scoutData.currentSha as string) || (scoutData.branch as string) || 'HEAD';

    const reqId = ++activeReqIdRef.current;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let isDeadConnection = false;
    let inactivityTimer: NodeJS.Timeout | null = null;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        isDeadConnection = true;
        controller.abort();
      }, INACTIVITY_TIMEOUT_MS);
    };
    resetInactivityTimer();

    const currentRetry = options?.retryCount ?? 0;
    setIsGeneratingOutline(true);
    setHasCompletedGen(false);
    wizardSetters.setDraftLoading(true);
    setOutlineGenError(null);
    setTechnicalDetail(null);
    wizardSetters.setOutlineGenError(null);

    const promptToSend = options?.customPrompt !== undefined ? options.customPrompt : customPrompt;
    // 档位统一收口：显式 options 优先，否则继承当前档位（点「更深入」后点
    // 「AI 重新编排」/重配 Key/空态重生成均保持档位，不静默退回 0）
    const effectiveRollupLevel = options?.rollupLevel ?? rollupLevel;
    if (options?.customPrompt !== undefined) {
      wizardSetters.setCustomPrompt(options.customPrompt);
    }

    let willRetry = false;
    let isAborted = false;
    try {
      const res = await fetch('/api/scout/tree-outline', {
        method: 'POST',
        headers: {
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          owner: scoutData.owner,
          repo: scoutData.repo,
          sha,
          targetLanguage: generativeLanguage,
          prefix: (selectedPrefix as string) || undefined,
          excludedPaths: excludedPaths.length > 0 ? excludedPaths : undefined,
          customPrompt: promptToSend || undefined,
          pacing: options?.pacing || undefined,
          teachingDepth: teachingDepth || undefined,
          learnerArchetype: options?.learnerArchetype || undefined,
          rollupLevel: effectiveRollupLevel ?? undefined,
          retry: options?.retry || undefined,
        }),
      });

      if (activeReqIdRef.current !== reqId) return;

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const isRateLimit =
          res.status === 429 ||
          /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(detail);
        if (isRateLimit) {
          const err = new Error(`RATE_LIMITED: ${detail.slice(0, 160)}`);
          (err as any).isRateLimit = true;
          throw err;
        }
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 160)}`);
      }

      const contentType = res.headers.get('content-type') || '';
      let data: any = null;

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        const dispatchEvent = () => {
          if (!currentEvent && !currentData) return;
          if (currentEvent === 'step') {
            try {
              const stepObj = JSON.parse(currentData);
              if (stepObj.title && stepObj.detail) {
                setPrepHint(`${stepObj.title}: ${stepObj.detail}`);
              } else if (stepObj.detail) {
                setPrepHint(stepObj.detail);
              }
            } catch {
              // ignore malformed step
            }
          } else if (currentEvent === 'complete') {
            try {
              const parsed = JSON.parse(currentData);
              data = parsed.data ?? parsed;
            } catch (e) {
              throw new Error(`Failed to parse complete data: ${String(e)}`);
            }
          } else if (currentEvent === 'error') {
            try {
              const errObj = JSON.parse(currentData);
              const streamErr = new Error(errObj.message || 'Stream error');
              if (errObj.status === 429 || errObj.code === 'RATE_LIMITED') {
                (streamErr as any).isRateLimit = true;
                (streamErr as any).status = 429;
              }
              // 结构化错误码透传（2026-11 A 类收口最后一跳）：KEY_DECRYPT_FAILED /
              // MISSING_API_KEY 需到达错误卡片引导重配 Key，不得丢弃 code
              if (errObj.code) {
                (streamErr as any).code = errObj.code;
                (streamErr as any).status = errObj.status;
              }
              throw streamErr;
            } catch (e) {
              if (e instanceof Error && e.message !== 'Stream error') throw e;
              throw new Error(currentData || 'Stream error');
            }
          }
          currentEvent = '';
          currentData = '';
        };

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) {
            dispatchEvent();
            return;
          }

          if (line.startsWith(':')) {
            // 心跳保活帧 (ping)
            resetInactivityTimer();
            return;
          }

          if (line.startsWith('event:')) {
            let val = line.slice(6);
            if (val.startsWith(' ')) val = val.slice(1);
            currentEvent = val.trim();
          } else if (line.startsWith('data:')) {
            let val = line.slice(5);
            if (val.startsWith(' ')) val = val.slice(1);
            currentData = currentData ? currentData + '\n' + val : val;
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              if (buffer.trim()) {
                processLine(buffer);
              }
              break;
            }
            resetInactivityTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              processLine(line);
            }
          }
          dispatchEvent();

          if (!data) {
            throw new Error(m.import_outline_stream_interrupted());
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          reader.releaseLock();
        }
      } else {
        const json = await res.json();
        if (activeReqIdRef.current !== reqId) return;
        data = json.data ?? json;
      }

      if (activeReqIdRef.current !== reqId) return;

      // 冷启动准备（202 契约）：巨仓归档下载+建图在 sidecar 后台进行，
      // 本请求无产物——保持等待态，按 retryAfterMs 有界轮询。
      if (data.preparing) {
        const pollCount = options?.prepPoll ?? 0;
        if (pollCount >= PREP_POLL_MAX) {
          throw new Error(m.import_prep_timeout());
        }
        willRetry = true;
        setPrepHint(data.detail || m.import_prep_hint_default());
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = setTimeout(() => {
          void generateTreeOutline({ ...options, prepPoll: pollCount + 1 });
        }, Math.min(Math.max(data.retryAfterMs ?? 8000, 3000), 30000));
        return;
      }
      setPrepHint(null);

      setRateLimitRetrying(false);

      if (data.resolvedSha && (!scoutData.currentSha || scoutData.currentSha !== data.resolvedSha)) {
        useImportWizardStore.setState((s) => ({
          scoutData: s.scoutData ? { ...s.scoutData, currentSha: data.resolvedSha } : s.scoutData,
        }));
      }

      if (data.courseTree || data.macroTopology) {
        useImportWizardStore.setState((s) => ({
          scoutData: s.scoutData ? {
            ...s.scoutData,
            courseTree: data.courseTree ?? (s.scoutData as any)?.courseTree,
            macroTopology: data.macroTopology ?? (s.scoutData as any)?.macroTopology,
          } : s.scoutData,
        }));
      }

      setOutlineDepth(data.depth === 2 ? 2 : 1);
      rollupCappedRef.current = Boolean(data.stats?.diagnostics?.needRollupCapped);

      let chaptersToSet = data.chapters ?? [];
      if (data.depth === 2 && data.courseTree) {
        const tree = data.courseTree;
        const allCourses = [
          ...(tree.overviewCourse ? [tree.overviewCourse] : []),
          ...(tree.subCourses || []),
        ];
        chaptersToSet = mergeTreeCoursesToSingleOutline(allCourses);
      }

      if (!chaptersToSet || chaptersToSet.length === 0) {
        const errMsg = m.import_outline_error_desc();
        setOutlineGenError(errMsg);
        wizardSetters.setOutlineGenError(errMsg);
      } else {
        wizardSetters.setCustomOutline(chaptersToSet);
        if (Array.isArray(data.excludedFiles)) {
          wizardSetters.setOutlineExcluded(data.excludedFiles);
        }
        // 分类懒取：不 await——响应已返回、大纲已呈现，预填晚到由 MetadataBar 守卫合并
        void fetchRepoMetadata(chaptersToSet, data.stats, reqId);
      }
      wizardSetters.setIsOutlineDirty(false);

      trackEvent({
        eventType: 'OUTLINE_TREE_GENERATED',
        duration: data.stats?.durationMs,
        metadata: {
          depth: data.depth,
          chapters: data.chapters?.length ?? 0,
          files: data.stats?.files,
        },
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (!isDeadConnection) {
          isAborted = true;
          return;
        }
        console.warn('Tree outline request timed out after inactivity');
      }

      if (activeReqIdRef.current !== reqId) return;

      const msg = String(err?.message || err);
      const isRateLimit =
        Boolean(err?.isRateLimit) ||
        err?.status === 429 ||
        err?.statusCode === 429 ||
        /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(msg);

      if (isRateLimit && currentRetry < 1) {
        willRetry = true;
        setRateLimitRetrying(true);
        setOutlineGenError(null);
        wizardSetters.setOutlineGenError(null);
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = setTimeout(() => {
          void generateTreeOutline({ ...options, retryCount: currentRetry + 1 });
        }, 1500);
        return;
      }

      setRateLimitRetrying(false);
      setPrepHint(null);
      console.warn('Tree outline generation failed:', err);
      const parsed = parseOutlineError(err);
      setOutlineGenError(parsed.message);
      setOutlineGenErrorCode(parsed.code ?? null);
      setTechnicalDetail(parsed.detail || null);
      wizardSetters.setOutlineGenError(parsed.message);
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (activeReqIdRef.current === reqId) {
        if (isAborted) {
          // 单一所有权收敛：abort 路径同样清空全部等待态——否则 draftLoading
          // （store 级、跨挂载存活）残留 true 会与空大纲组合成永久幽灵 spinner
          setIsGeneratingOutline(false);
          wizardSetters.setDraftLoading(false);
          setHasCompletedGen(true);
          triggeredKeyRef.current = '';
        } else if (!willRetry) {
          setIsGeneratingOutline(false);
          wizardSetters.setDraftLoading(false);
          setHasCompletedGen(true);
        }
      }
    }
  }, [scoutData, targetLanguage, generativeLanguage, selectedPrefix, excludedPaths, customPrompt, teachingDepth, rollupLevel, parseOutlineError, fetchRepoMetadata]);
  /** 探查档位调整（用户反馈式）：每次点击 = 授权一档固定增量，重新规划整份大纲 */
  const handleRollupAdjust = useCallback((direction: 'deeper' | 'shallower') => {
    const next = direction === 'deeper'
      ? Math.min(rollupLevel + 1, 3)
      : Math.max(rollupLevel - 1, 0);
    if (next === rollupLevel) return;
    trackEvent({
      eventType: 'OUTLINE_DEEPENING_CLICKED',
      metadata: { level: next, direction, prevCapped: rollupCappedRef.current },
    });
    setRollupLevel(next);
    triggeredKeyRef.current = '';
    void generateTreeOutline({ rollupLevel: next });
  }, [rollupLevel, generateTreeOutline]);

  const [previousOutline, setPreviousOutline] = useState<typeof customOutline | null>(null);

  const handleReorganizeOutline = useCallback((options: ReorganizeOptions) => {
    if (customOutline.length > 0) {
      setPreviousOutline(customOutline);
    }
    void generateTreeOutline(options);
  }, [customOutline, generateTreeOutline]);

  const handleUndoReorganize = useCallback(() => {
    if (!previousOutline || previousOutline.length === 0) return;
    wizardSetters.setCustomOutline(previousOutline);
    setPreviousOutline(null);
  }, [previousOutline]);


  useEffect(() => {
    if (
      step === 2 &&
      !isExecuting &&
      !loading &&
      !prefixLoading &&
      Boolean(scoutData?.owner && scoutData?.repo) &&
      customOutline.length === 0 &&
      !isGeneratingRef.current &&
      triggeredKeyRef.current !== currentTargetKey
    ) {
      triggeredKeyRef.current = currentTargetKey;
      setHasCompletedGen(false);
      void generateTreeOutline();
    }
  }, [step, isExecuting, loading, prefixLoading, scoutData?.owner, scoutData?.repo, customOutline.length, currentTargetKey, generateTreeOutline]);

  // 幽灵 spinner 自愈（失效封闭）：等待态但零在途请求超过 15s = 状态机残骸
  // （dev 重启掐断在途请求、abort 残留、触发闸已消费等历史入口）——直接补发
  // 一次真实请求替代无限空转；失败/成功都会落定到大纲或错误态，天然无循环
  useEffect(() => {
    if (
      step !== 2 ||
      isExecuting ||
      loading ||
      prefixLoading ||
      isGeneratingOutline ||
      !scoutData?.owner ||
      !scoutData?.repo ||
      customOutline.length > 0 ||
      outlineGenError
    ) {
      return;
    }
    const timer = setTimeout(() => {
      triggeredKeyRef.current = '';
      void generateTreeOutline();
    }, 15_000);
    return () => clearTimeout(timer);
  }, [step, isExecuting, loading, prefixLoading, isGeneratingOutline, scoutData?.owner, scoutData?.repo, customOutline.length, outlineGenError, generateTreeOutline]);

  // 动态展开或加载中骨架屏
  if (!isExecuting && (prefixLoading || loading || !scoutData)) {
    return (
      <div className="flex-1 min-h-0 flex flex-col space-y-3 animate-in fade-in duration-300">
        <div className="flex flex-wrap items-center justify-between gap-3 shrink-0 p-3 bg-theme-bg border border-theme-border rounded-xl shadow-2xs">
          <div className="flex items-center gap-4">
            <Skeleton className="h-7 w-48 rounded-md" />
            <Skeleton className="h-7 w-36 rounded-md" />
          </div>
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      </div>
    );
  }

  const handleStartIngestSubmit = () => {
    if (validateOutline()) {
      handleIngest();
    }
  };

  const handleGoToTutorial = () => {
    if (!ingestSuccessInfo) return;
    const targetUrl = buildImportedTutorialHref(ingestSuccessInfo);
    resetWizard();
    router.push(targetUrl);
  };

  const handleGoToShelf = () => {
    resetWizard();
    router.push('/?tab=my-shelf');
  };

  return (
    <div className="flex flex-col space-y-3 animate-in fade-in duration-300 flex-1 min-h-0">
      {/* 1. TOP CONTROL BAR (Seamless Back Button & Read-Only Badges) */}
      {(!isExecuting || ingestFailed) && (
        <div className="flex flex-wrap items-center justify-between gap-3 shrink-0 py-0.5 text-xs">
          <button
            type="button"
            onClick={handleRestart}
            className="text-xs font-serif font-bold text-theme-primary hover:text-theme-primary/80 flex items-center gap-1.5 cursor-pointer py-1 px-2.5 rounded-lg bg-theme-primary/10 border border-theme-primary/20 transition-all active:scale-[0.97]"
          >
            <ArrowLeft size={14} />
            <span>{m.common_back()}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const depthLabel =
                teachingDepth === 'overview'
                  ? m.import_depth_beginner()
                  : teachingDepth === 'deep'
                  ? m.import_depth_deep()
                  : m.import_depth_standard();
              const intent = customPrompt.trim();
              const echoIntent = intent.length > 20 ? `${intent.slice(0, 20)}…` : intent;
              const isCustomized = teachingDepth !== 'standard' || Boolean(intent);
              return (
                <span
                  className={
                    isCustomized
                      ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-primary/10 border border-theme-primary/30 text-theme-primary text-xs cursor-default select-none max-w-[300px]'
                      : 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-surface/40 border border-theme-border/30 text-theme-muted text-xs cursor-default select-none max-w-[300px]'
                  }
                  title={intent || undefined}
                >
                  <Gauge size={12} className="shrink-0 opacity-75" />
                  <span className="font-serif truncate">
                    {m.import_depth_preference()}: {depthLabel}
                    {echoIntent ? ` · ${echoIntent}` : ''}
                  </span>
                </span>
              );
            })()}

            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-surface/40 border border-theme-border/30 text-theme-muted text-xs cursor-default select-none">
              <FolderTree size={12} className="text-theme-muted/60 shrink-0" />
              <span className="text-theme-muted font-serif">{m.directory_label()}</span>
              <span className="font-mono text-theme-muted/90 font-normal">{selectedPrefix || '/'}</span>
            </span>

            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-surface/40 border border-theme-border/30 text-theme-muted text-xs cursor-default select-none">
              <Globe size={12} className="text-theme-muted/60 shrink-0" />
              <span className="text-theme-muted font-serif">{m.language_label()}</span>
              <span className="font-serif text-theme-muted/90 font-normal">
                {SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.nativeName ||
                  SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.name ||
                  (targetLanguage === 'none' ? m.language_no_translate() : targetLanguage)}
              </span>
            </span>

            <WizardModelBadge variant="pill" />
          </div>
        </div>
      )}

      {/* 草稿恢复提示条（防手滑、崩溃或刷新导致的心血丢失） */}
      {!isExecuting && hasRecoverableDraft && (
        <div className="flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs shrink-0 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-serif font-medium truncate">
              {m.import_draft_detected({ time: recoverableDraftTimeText })}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRecoverDraft}
              className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white font-serif font-bold text-xs rounded-md transition-colors shadow-2xs cursor-pointer"
            >
              {m.import_draft_recover()}
            </button>
            <button
              type="button"
              onClick={handleDiscardDraft}
              className="px-2 py-1 text-theme-muted hover:text-theme-foreground font-serif text-xs transition-colors cursor-pointer"
            >
              {m.import_draft_discard()}
            </button>
          </div>
        </div>
      )}

      {/* 2. MAIN WORKBENCH CANVAS */}
      {!isExecuting ? (
        (isGeneratingOutline || draftLoading || (!hasCompletedGen && !outlineGenError && customOutline.length === 0)) ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-8 bg-theme-bg border border-theme-border/80 rounded-xl shadow-2xs text-center space-y-4 animate-in fade-in duration-200">
            <div className="p-3.5 rounded-full bg-theme-primary/10 border border-theme-primary/20 text-theme-primary">
              <Loader2 size={28} className="animate-spin text-theme-primary" />
            </div>
            <div className="space-y-2 max-w-md">
              <h3 className="text-sm font-semibold text-theme-foreground">
                {rateLimitRetrying
                  ? m.import_outline_rate_limit_queue()
                  : m.import_outline_planning()}
              </h3>
              {prepHint && (
                <div className="pt-1 flex items-center justify-center">
                  <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-theme-primary/10 border border-theme-primary/20 text-theme-primary font-medium shadow-2xs animate-in fade-in duration-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-pulse" />
                    {prepHint}
                  </span>
                </div>
              )}
              {excludedPaths.length > 0 && (
                <div className="pt-1">
                  <span className="inline-flex items-center gap-1 text-micro px-2 py-0.5 rounded-full bg-theme-surface border border-theme-border text-theme-muted">
                    {m.import_outline_excluded_auxiliary({ count: excludedPaths.length })}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : outlineGenError && customOutline.length === 0 ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-8 bg-theme-bg border border-theme-border/80 rounded-xl shadow-2xs text-center space-y-4 animate-in fade-in duration-200">
            <div className="p-3.5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-500">
              {isOffline ? <WifiOff size={28} /> : <AlertTriangle size={28} />}
            </div>
            <div className="space-y-1.5 max-w-md">
              <h3 className="text-sm font-semibold text-theme-foreground font-sans">
                {isOffline ? m.import_outline_network_offline() : m.import_outline_error_title()}
              </h3>
              <p className="text-xs text-theme-muted leading-relaxed">
                {outlineGenError}
              </p>
              {technicalDetail && (
                <div className="pt-1">
                  <span className="inline-block text-micro font-mono text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-0.5 rounded-md max-w-sm truncate">
                    {technicalDetail}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleRestart}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer font-serif"
              >
                <ArrowLeft size={13} />
                <span>{m.import_outline_restart()}</span>
              </button>
              {outlineGenErrorCode === 'KEY_DECRYPT_FAILED' || outlineGenErrorCode === 'MISSING_API_KEY' ? (
                // 密钥类故障的主按钮：直达 Key 重配弹窗，保存成功后自动重试大纲
                <button
                  type="button"
                  onClick={() => {
                    useModalStore.getState().openApiKeyModal({
                      contextText: outlineGenErrorCode === 'KEY_DECRYPT_FAILED' ? m.toast_key_decrypt_failed_desc() : m.toast_missing_api_key(),
                      onCompleted: () => {
                        triggeredKeyRef.current = '';
                        void generateTreeOutline({ retry: true });
                      },
                    });
                  }}
                  className="px-4 py-1.5 bg-theme-primary text-theme-primary-fg text-xs font-medium rounded-lg hover:opacity-90 transition-all cursor-pointer font-serif shadow-2xs"
                >
                  {m.toast_config_model_hint()}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    triggeredKeyRef.current = '';
                    void generateTreeOutline({ retry: true, rollupLevel });
                  }}
                  className="px-4 py-1.5 bg-theme-primary text-theme-primary-fg text-xs font-medium rounded-lg hover:opacity-90 transition-all cursor-pointer font-serif shadow-2xs"
                >
                  {m.import_outline_retry()}
                </button>
              )}
            </div>
          </div>
        ) : customOutline.length === 0 ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-8 bg-theme-bg border border-theme-border rounded-xl shadow-2xs text-center min-h-[380px] space-y-4 animate-in fade-in duration-200">
            <div className="p-3 rounded-full bg-theme-surface border border-theme-border text-theme-muted">
              <FolderTree size={30} className="text-theme-primary" />
            </div>
            <div className="space-y-1.5 max-w-md">
              <h3 className="text-sm font-semibold text-theme-foreground font-sans">
                {m.import_outline_incomplete_title()}
              </h3>
              <p className="text-xs text-theme-muted leading-relaxed">
                {m.import_outline_incomplete_desc()}
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleRestart}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer"
              >
                <ArrowLeft size={13} />
                <span>{m.scout_feedback_back_to_edit()}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  triggeredKeyRef.current = '';
                  setHasCompletedGen(false);
                  void generateTreeOutline();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-primary text-theme-primary-fg text-xs font-medium hover:opacity-90 transition-all cursor-pointer shadow-2xs"
              >
                <Sparkles size={13} />
                <span>{m.ingest_regenerate()}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col space-y-2">
            {outlineDepth === 2 && (
              <div className="flex items-center justify-between gap-3 px-1">
                <div className="inline-flex items-center bg-theme-bg/60 p-0.5 rounded-lg border border-theme-border">
                  <button
                    type="button"
                    disabled={rollupLevel <= 0}
                    onClick={() => handleRollupAdjust('shallower')}
                    className="px-3 py-1 text-xs text-theme-muted hover:text-theme-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
                  >
                    − {m.workbench_rollup_shallow()}
                  </button>
                  <span className="px-2 text-xs text-theme-muted font-medium whitespace-nowrap">
                    {m.workbench_rollup_label()} {rollupLevel}/3
                  </span>
                  <button
                    type="button"
                    disabled={rollupLevel >= 3}
                    onClick={() => handleRollupAdjust('deeper')}
                    className="px-3 py-1 text-xs text-theme-muted hover:text-theme-primary disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer font-medium"
                  >
                    ＋ {m.workbench_rollup_deepen()}
                  </button>
                </div>
                <span className="text-micro text-theme-muted truncate">
                  {rollupLevel >= 3 ? m.workbench_rollup_max_hint() : m.workbench_rollup_replan_note()}
                </span>
              </div>
            )}
            <WorkbenchOutlineEditor
              canUndoReorganize={Boolean(previousOutline && previousOutline.length > 0)}
              onUndoReorganize={handleUndoReorganize}
            />
          </div>
        )
      ) : (
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
          {ingestFailed && !ingestSuccessInfo && (
            <div className="bg-theme-surface border border-rose-500/30 rounded-xl p-4 shadow-xs font-sans text-theme-foreground animate-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-rose-500/15 text-rose-600 border border-rose-500/30 font-mono font-bold text-xs">
                    ERR
                  </span>
                  <div>
                    <h4 className="font-serif font-bold text-sm text-theme-foreground">
                      {m.import_workbench_failed_title()}
                    </h4>
                    <p className="text-xs text-theme-muted mt-0.5">
                      {m.import_workbench_failed_desc()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={importMode === 'web' ? retryWebDocImport : handleIngest}
                    className="px-4 py-2 bg-theme-primary hover:opacity-90 text-theme-primary-fg font-serif font-bold text-xs rounded-lg transition-all cursor-pointer active:scale-95"
                  >
                    {m.import_workbench_retry()}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (importMode === 'web') {
                        wizardFlow.goBackToScope();
                      } else {
                        wizardFlow.goToStep(2);
                      }
                    }}
                    className="px-4 py-2 border border-theme-border text-theme-muted hover:text-theme-foreground font-serif font-bold text-xs rounded-lg transition-all cursor-pointer"
                  >
                    {m.scout_feedback_back_to_edit()}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseRequest}
                    className="px-4 py-2 border border-theme-border text-theme-muted hover:text-rose-600 font-serif font-bold text-xs rounded-lg transition-all cursor-pointer"
                  >
                    {m.common_close()}
                  </button>
                </div>
              </div>
            </div>
          )}

          <WorkbenchStep3Executing onGoToTutorial={handleGoToTutorial} onGoToShelf={handleGoToShelf} />
        </div>
      )}

      {/* 3. BOTTOM STICKY ACTION BAR */}
      {!isExecuting && customOutline.length > 0 && (
        <div className="px-4 py-2.5 bg-theme-surface/40 border border-theme-border/60 rounded-xl flex flex-wrap items-center justify-between gap-3 w-full shrink-0">
          {/* Left: Writing / Transcription Style Settings */}
          <WorkbenchTranscriptionSettings />

          {/* Center-Right: 1 Primary + 4 Secondary Reorganize Controls */}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <WorkbenchReorganizeBar
              onReorganize={handleReorganizeOutline}
              disabled={isGeneratingOutline}
            />

            <div className="h-5 w-px bg-theme-border/60 hidden sm:block shrink-0" />

            <button
              type="button"
              onClick={handleStartIngestSubmit}
              disabled={isGeneratingOutline}
              className="px-7 py-2.5 bg-theme-primary hover:opacity-90 text-theme-primary-fg font-serif font-bold tracking-[0.1em] rounded-lg transition-all flex items-center justify-center gap-2 text-xs shadow-md cursor-pointer active:scale-95 shrink-0 disabled:opacity-50"
            >
              <Sparkles size={13} className="shrink-0" />
              <span>{m.import_workbench_start_btn()}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
