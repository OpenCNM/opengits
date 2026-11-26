'use client';

import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import { ignoreBestEffort } from '@/lib/best-effort';
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
        ignoreBestEffort();
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

      const resolvedPrefix = data.versions?.length ? matchedPrefix : '';
      const autoPrune = useImportWizardStore.getState().autoPruneAuxiliary;
      const scopeVerdict = data.scopeVerdict as
        | { targetRoot?: string; auxiliaryPaths?: string[]; rationale?: string }
        | null
        | undefined;
      const auxiliaryPaths: string[] = Array.isArray(scopeVerdict?.auxiliaryPaths)
        ? scopeVerdict.auxiliaryPaths
        : [];
      let initialExcludedPaths: string[] = [];
      if (autoPrune && auxiliaryPaths.length > 0 && Array.isArray(data.dirTree)) {
        const cleanPrefix = resolvedPrefix.trim().replace(/^\/|\/$/g, '');
        const candidates = !cleanPrefix
          ? data.dirTree.filter((n: any) => n.depth === 1)
          : (() => {
              const current = data.dirTree.find((n: any) => n.path.replace(/^\/|\/$/g, '') === cleanPrefix);
              if (current?.children?.length > 0) return current.children;
              return data.dirTree.filter(
                (n: any) => n.path.startsWith(cleanPrefix + '/') && n.depth === cleanPrefix.split('/').length + 1
              );
            })();
        const auxSet = new Set(auxiliaryPaths);
        initialExcludedPaths = candidates.filter((n: any) => auxSet.has(n.path)).map((n: any) => n.path);
      }

      const effDedup = data.dedupInfo ?? null;
      const sameSourceHit = Boolean(
        data.sameSource &&
        !effDedup?.existsOnShelf &&
        !effDedup?.existsInExplore &&
        !(effDedup?.isFork && effDedup?.upstream)
      );
      const hasDupHit = Boolean(
        effDedup && (effDedup.existsOnShelf || effDedup.existsInExplore || effDedup.isFork)
      );
      const shouldShowDedup = (hasDupHit || sameSourceHit) && !preserveDismissed;

      useImportWizardStore.setState({
        scoutData: data,
        scoutedUrl: targetUrl,
        scoutSameSource: data.sameSource ?? null,
        dedupInfo: effDedup,
        repoPreExisted: Boolean(
          data.dedupInfo?.existsOnShelf ||
          data.dedupInfo?.existsInExplore ||
          data.dedupInfo?.baseSlotOccupied
        ),
        recommendedPrefix: resolvedPrefix,
        selectedPrefix: resolvedPrefix,
        targetLanguage: currentTargetLang,
        customOutline: initialOutline,
        excludedPaths: initialExcludedPaths,
        outlineGenError: null,
        draftOutline: null,
        draftLoading: !shouldShowDedup && initialOutline.length === 0,
        isOutlineDirty: false,
        originalOutlineSnapshot: null,
        hasRecoverableDraft: false,
        recoverableDraftUpdatedAt: null,
        collapsedCategories: {},
        ingestFailed: false,
        ingestSuccessInfo: null,
        category: data.aiCategory || useImportWizardStore.getState().category,
        tagPool: nextTagPool,
        selectedTags: aiGenTags.length > 0 ? aiGenTags : useImportWizardStore.getState().selectedTags,
        hasDismissedDedup: preserveDismissed,
        step: shouldShowDedup ? 1 : 2,
        subStep: shouldShowDedup ? 'directory_confirm' : 'outline_draft',
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

    wizardFlow.enterOrchestration();
  };

  const handleSelectPrefix = async (prefix: string) => {
    setSelectedPrefix(prefix);
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
