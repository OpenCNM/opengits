'use client';

import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { executeScoutPipeline } from '@/lib/import-wizard/wizard-scout-service';
import { triggerGithubReauth } from '@/lib/import-wizard/wizard-reauth';
import { isReauthInCooldown, clearReauthAttempt } from '@/lib/stores/pending-import-reauth';
import { wizardFlow, wizardSetters, useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { hasConfiguredApiKey, requireApiKey } from '@/lib/api-key-guard';
import * as m from '@/paraglide/messages';

export function useWizardScout(locale: string = 'zh-CN') {
  const wizard = useImportWizardStore();
  const {
    url,
    importScopeMode,
    targetLanguage,
    scoutData,
    selectedPrefix,
    customPrompt,
  } = wizard;

  const {
    setUrl,
    setParsedUrlInfo,
    setTargetLandingPath,
    setImportMode,
    setWebScoutPhase,
    setScoutError,
    setSubStep,
    setLoading,
    setScoutSteps,
    setScoutData,
    setScoutSameSource,
    setDedupInfo,
    setRepoPreExisted,
    setRecommendedPrefix,
    setSelectedPrefix,
    setTargetLanguage,
    setCustomOutline,
    setCategory,
    setTagPool,
    setSelectedTags,
    setHasDismissedDedup,
    setIsOpen,
    setStep,
    setOutlineExcluded,
  } = wizardSetters;

  const handleScout = async (overrideUrl?: string, options?: { forceScout?: boolean }) => {
    if (!hasConfiguredApiKey()) {
      requireApiKey(() => {
        void handleScout(overrideUrl, options);
      }, m.apikey_continue_parse());
      return;
    }

    setScoutError(null);
    const targetUrl = (overrideUrl || url).trim();
    if (overrideUrl) {
      setUrl(targetUrl);
    }
    const { inspectGithubUrl } = await import('@/lib/url-inspector');
    const inspection = inspectGithubUrl(targetUrl);
    setParsedUrlInfo(inspection);

    if (inspection.filePath) {
      setTargetLandingPath(inspection.filePath);
    } else {
      setTargetLandingPath('');
    }

    // 网页文档分流：非 GitHub 的 http(s) 文档站 → web 向导（Go sidecar webdoc 管线，不走 GitHub scout）
    if (inspection.resourceType === 'web-doc' && inspection.webUrl) {
      wizardFlow.enterWebConfirm(targetUrl);
      return;
    }
    setImportMode('github');
    setWebScoutPhase('idle');

    if (!options?.forceScout && wizardFlow.resumeFromInput()) {
      return;
    }

    if (!inspection.isValid) {
      setScoutError({
        status: inspection.status,
        error: inspection.diagnosticTitle,
        diagnosticDescription: inspection.diagnosticDescription,
        suggestedFormat: inspection.suggestedFormat,
      });
      return;
    }

    const { owner, repo } = inspection;
    const isEdition = useImportWizardStore.getState().createEdition;

    // Fast-path: 极速预检查重 (Asymmetric Compute: 毫秒级短路已有仓库，规避进入重度探测与图1进度指示)
    if (!options?.forceScout && !isEdition && owner && repo) {
      setLoading(true);
      setScoutSteps([]);
      try {
        const dedupRes = await api.post<{ dedupInfo: any }>(
          '/api/repos/check-dedup',
          { owner, repo },
          { onUnauthorized: 'throw' }
        );
        if (dedupRes?.dedupInfo && (dedupRes.dedupInfo.existsInExplore || dedupRes.dedupInfo.existsOnShelf)) {
          useImportWizardStore.setState({
            dedupInfo: dedupRes.dedupInfo,
            repoPreExisted: true,
            hasDismissedDedup: false,
            subStep: 'directory_confirm',
            loading: false,
            scoutSteps: [],
            isOpen: true,
          });
          return;
        }
      } catch {
        // Fail-closed fallback: 预检接口异常时不阻断流程，平滑降级走完整 scout 管线
      }
    }

    setLoading(true);
    setScoutSteps([]);
    setSubStep('input');
    try {
      const currentTargetLang =
        useImportWizardStore.getState().targetLanguage || targetLanguage || locale || TRANSLATION_LANGUAGES.DEFAULT_CODE;

      const scoutRes = await executeScoutPipeline({
        url: targetUrl,
        importScopeMode,
        filePath: inspection.filePath || undefined,
        targetLanguage: currentTargetLang,
        onStep: (step) => setScoutSteps((prev) => [...prev, step]),
      });

      if (!scoutRes.ok) {
        if (scoutRes.error.status === 'GITHUB_TOKEN_EXPIRED') {
          if (!isReauthInCooldown()) {
            useImportWizardStore.setState({ isReauthorizing: true, loading: false });
            triggerGithubReauth({ url: targetUrl });
            return;
          }
        }
        setScoutError(scoutRes.error);
        return;
      }

      clearReauthAttempt();

      const { data, matchedPrefix } = scoutRes;

      // 第一性原理：targetLanguage（教程内容生成目标语言）是用户在向导中做出的最高主权决策。
      // 绝不能用 locale（前端展示多语言）去盲目覆写用户设定的 targetLanguage。
      let initialOutline: any[] = [];
      if (data.versions && data.versions.length > 0) {
        if (data.outlinesByPrefix?.[matchedPrefix]) {
          initialOutline = structuredClone(data.outlinesByPrefix[matchedPrefix]);
        }
      }

      const rawTags = Array.isArray(data.aiTags)
        ? data.aiTags
        : typeof data.aiTags === 'string'
        ? data.aiTags.split(/[,，]/)
        : [];
      const aiGenTags = rawTags.map((t: any) => String(t).trim()).filter(Boolean);
      const currentTagPool = useImportWizardStore.getState().tagPool;
      const nextTagPool = Array.from(new Set([...currentTagPool, ...aiGenTags]));

      const preserveDismissed = Boolean(
        options?.forceScout ||
        useImportWizardStore.getState().hasDismissedDedup ||
        useImportWizardStore.getState().createEdition
      );

      useImportWizardStore.setState({
        scoutData: data,
        scoutedUrl: targetUrl,
        scoutSameSource: data.sameSource ?? null,
        dedupInfo: data.dedupInfo ?? null,
        repoPreExisted: Boolean(data.dedupInfo?.existsOnShelf || data.dedupInfo?.existsInExplore),
        recommendedPrefix: data.versions?.length ? matchedPrefix : '',
        selectedPrefix: data.versions?.length ? matchedPrefix : '',
        targetLanguage: currentTargetLang,
        customOutline: initialOutline,
        excludedPaths: [],
        outlineGenError: null,
        draftOutline: null,
        isOutlineDirty: false,
        originalOutlineSnapshot: null,
        hasRecoverableDraft: false,
        recoverableDraftUpdatedAt: null,
        ingestFailed: false,
        ingestSuccessInfo: null,
        category: data.aiCategory || useImportWizardStore.getState().category,
        tagPool: nextTagPool,
        selectedTags: aiGenTags.length > 0 ? aiGenTags : useImportWizardStore.getState().selectedTags,
        hasDismissedDedup: preserveDismissed,
        step: 1,
        subStep: 'directory_confirm',
        isOpen: true,
        loading: false,
      });
    } catch (e: any) {
      toastManager.add({
        type: 'error',
        title: m.import_scout_failed_title(),
        description: e.message,
      });
    } finally {
      setLoading(false);
    }
  };

  const proceedToStep2 = async (_customPrefix?: string) => {
    if (!hasConfiguredApiKey()) {
      requireApiKey(() => {
        void proceedToStep2(_customPrefix);
      }, m.apikey_continue_parse());
      return;
    }

    // 进入步骤 2（大纲规划/编排）：原子初始化大纲生成上下文，清理历史弹窗残留变量
    wizardFlow.enterOrchestration();
  };

  const handleSelectPrefix = async (prefix: string) => {
    setSelectedPrefix(prefix);
    // 换目录即换编排上下文：上一目录的排除路径与被过滤文件清单重置
    wizardSetters.setExcludedPaths([]);
    setOutlineExcluded([]);

    if (scoutData?.outlinesByPrefix?.[prefix]) {
      setCustomOutline(structuredClone(scoutData.outlinesByPrefix[prefix]));
    } else {
      setCustomOutline([]);
    }
  };

  return {
    handleScout,
    proceedToStep2,
    handleSelectPrefix,
  };
}
