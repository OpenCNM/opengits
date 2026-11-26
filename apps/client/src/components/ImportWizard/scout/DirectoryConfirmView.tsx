'use client';
import * as m from '@/paraglide/messages';

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ArrowLeft, BookOpen, FileText, Filter, Folder, FolderOpen, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { ParsedGithubUrl } from '@/lib/url-parser';
import type { DirTreeNode, VersionEntry } from '@/lib/dir-verdict';
import type { DocCodeRatio, IngestMode } from '@/engine/repo-sniffer';
import { useImportWizardStore, wizardFlow, wizardSetters, type WizardSubStep } from '@/lib/stores/import-wizard-store';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';
import { detectLangFromPath } from '@/lib/languages';
import { DirectoryCascadePicker } from '../DirectoryCascadePicker';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api/client';
import { toastManager } from '@/components/ui/toast';

type ScoutVersionSummary = VersionEntry & { totalFiles?: number };

interface ScoutDataSnapshot {
  versions?: ScoutVersionSummary[];
  dirTree?: DirTreeNode[];
  primaryLanguage?: string;
  scopeVerdict?: { targetRoot: string; auxiliaryPaths: string[]; rationale: string } | null;
  profile?: {
    ingestMode?: IngestMode;
    docCodeRatio?: DocCodeRatio;
    detectedLanguage?: string;
  };
}

interface DirectoryConfirmViewProps {
  scoutData: ScoutDataSnapshot;
  parsedUrlInfo: ParsedGithubUrl | null;
  importScopeMode: 'full_repo' | 'single_doc';
  setImportScopeMode: (mode: 'full_repo' | 'single_doc') => void;
  selectedPrefix: string;
  recommendedPrefix: string;
  setSelectedPrefix: (prefix: string) => void;
  targetLanguage: string;
  showAllVersions: boolean;
  prefixLoading: boolean;
  setSubStep: (subStep: WizardSubStep) => void;
  onConfirmDirectory: () => void;
}

const DRAFT_STAGE_ORDER: Record<string, number> = {
  scope: 1,
  signals: 2,
  llm: 3,
  sanitize: 4,
};

export function DirectoryConfirmView({
  scoutData,
  parsedUrlInfo,
  importScopeMode,
  setImportScopeMode,
  selectedPrefix,
  recommendedPrefix,
  setSelectedPrefix,
  targetLanguage,
  showAllVersions,
  prefixLoading,
  onConfirmDirectory,
  setSubStep,
}: DirectoryConfirmViewProps) {
  const isGenerating = prefixLoading;
  const currentStageIndex = 1;
  const totalStages = 4;
  const versions = scoutData.versions || [];
  const featuredVersion = versions.find((v) => v.prefix === selectedPrefix) || versions[0] || { name: 'Root', prefix: '', totalFiles: 0 };
  const otherVersions = versions.filter((v) => v.prefix !== featuredVersion.prefix);
  const visibleOtherVersions = showAllVersions ? otherVersions : otherVersions.slice(0, 4);
  const targetLangName = SUPPORTED_LANGUAGES.find(l => l.code === targetLanguage)?.name || m.language_simplified_chinese();

  const detectedPrefixLang = detectLangFromPath(featuredVersion.prefix) || featuredVersion.lang || null;
  const repoPrimaryLang = scoutData.primaryLanguage || scoutData.profile?.detectedLanguage || 'zh-CN';

  let isNativeMatch = false;
  if (!targetLanguage || targetLanguage === 'none') {
    isNativeMatch = true;
  } else if (detectedPrefixLang) {
    const isZhPref = targetLanguage === 'zh-CN' || targetLanguage === 'zh';
    const isZhDetected = detectedPrefixLang === 'zh-CN' || detectedPrefixLang === 'zh';
    isNativeMatch = detectedPrefixLang === targetLanguage || (isZhPref && isZhDetected);
  } else {
    const isZhTarget = targetLanguage === 'zh-CN' || targetLanguage === 'zh';
    const isZhRepo = repoPrimaryLang === 'zh-CN' || repoPrimaryLang === 'zh';
    isNativeMatch = targetLanguage === repoPrimaryLang || (isZhTarget && isZhRepo);
  }

  const ratio = scoutData.profile?.docCodeRatio;
  const ingestMode = scoutData.profile?.ingestMode || (ratio && ratio.ratio < 0.20 ? 'code_only' : 'text_only');
  const isCodeOnly = ingestMode === 'code_only' || (ratio && ratio.codeFiles > 0 && ratio.ratio < 0.25);
  const isHybrid = ingestMode === 'hybrid' || (ratio && ratio.codeFiles > 10 && ratio.docFiles > 10);
  const codeFilesCount = ratio?.codeFiles ?? 0;
  const docFilesCount = featuredVersion.totalFiles ?? ratio?.docFiles ?? 0;

  const isRoot = !selectedPrefix || selectedPrefix.trim() === '' || selectedPrefix === '/';
  const currentVersion = versions.find((v) => v.prefix === selectedPrefix);

  const targetDisplayName = useMemo(() => {
    if (isRoot) {
      return m.scout_feedback_root_dir();
    }
    if (currentVersion?.name && currentVersion.name !== 'Root / Main Content') {
      return currentVersion.name;
    }
    return `/${selectedPrefix.replace(/^\/|\/$/g, '')}`;
  }, [isRoot, currentVersion, selectedPrefix]);

  const targetPathDisplay = useMemo(() => {
    if (isRoot) {
      return '/';
    }
    return selectedPrefix.startsWith('/') ? selectedPrefix : `/${selectedPrefix}`;
  }, [isRoot, selectedPrefix]);

  const candidateDirectories = useMemo(() => {
    const tree = scoutData.dirTree || [];
    const prefix = selectedPrefix.trim().replace(/^\/|\/$/g, '');
    if (!prefix) {
      return tree.filter((n) => n.depth === 1);
    }
    const current = tree.find((n) => n.path.replace(/^\/|\/$/g, '') === prefix);
    if (current && current.children && current.children.length > 0) {
      return current.children;
    }
    return tree.filter((n) => n.path.startsWith(prefix + '/') && n.depth === (prefix.split('/').length + 1));
  }, [scoutData.dirTree, selectedPrefix]);

  const [localScopeVerdict, setLocalScopeVerdict] = useState(scoutData.scopeVerdict ?? null);
  const [isReAnalyzing, setIsReAnalyzing] = useState(false);

  useEffect(() => {
    setLocalScopeVerdict(scoutData.scopeVerdict ?? null);
  }, [scoutData.scopeVerdict]);

  const activeScopeVerdict = localScopeVerdict ?? scoutData.scopeVerdict;

  const scopeAuxiliarySet = useMemo(
    () => new Set(activeScopeVerdict?.auxiliaryPaths ?? []),
    [activeScopeVerdict]
  );

  const auxiliaryCandidates = useMemo(() => {
    return candidateDirectories.filter((n) => scopeAuxiliarySet.has(n.path));
  }, [candidateDirectories, scopeAuxiliarySet]);

  const autoPruneAuxiliary = useImportWizardStore((s) => s.autoPruneAuxiliary);
  const excludedPathsInStore = useImportWizardStore((s) => s.excludedPaths);
  const customPrompt = useImportWizardStore((s) => s.customPrompt);
  const [showAiIntent, setShowAiIntent] = useState(Boolean(customPrompt));
  const [prunedPaths, setPrunedPaths] = useState<Set<string>>(() => {
    if (excludedPathsInStore.length > 0) return new Set(excludedPathsInStore);
    return new Set(auxiliaryCandidates.map((c) => c.path));
  });
  const [showCustomPrune, setShowCustomPrune] = useState(false);

  const handleReAnalyzeScope = async () => {
    if (isReAnalyzing || !parsedUrlInfo) return;
    setIsReAnalyzing(true);
    try {
      const res = await api.post<{ ok: boolean; verdict?: any }>('/api/scout/scope-verdict', {
        owner: parsedUrlInfo.owner,
        repo: parsedUrlInfo.repo,
        branch: parsedUrlInfo.branch,
        sha: (scoutData as any)?.currentSha,
        targetLanguage,
        customPrompt,
        forceRefresh: true,
      });

      if (res?.verdict) {
        setLocalScopeVerdict(res.verdict);
        useImportWizardStore.setState((s) => ({
          scoutData: {
            ...s.scoutData,
            scopeVerdict: res.verdict,
          },
          recommendedPrefix: res.verdict.targetRoot || '',
          selectedPrefix: res.verdict.targetRoot || '',
        }));
        setSelectedPrefix(res.verdict.targetRoot || '');
        toastManager.add({
          type: 'success',
          title: m.scout_ai_re_arbitrate_success(),
        });
      } else {
        toastManager.add({
          type: 'warning',
          title: m.scout_ai_re_arbitrate_failed(),
        });
      }
    } catch (err: any) {
      toastManager.add({
        type: 'error',
        title: m.scout_ai_re_arbitrate_failed(),
        description: err?.message,
      });
    } finally {
      setIsReAnalyzing(false);
    }
  };

  const prevScoutKeyRef = useRef<string | null>(null);
  const currentScoutKey = `${parsedUrlInfo?.owner || ''}/${parsedUrlInfo?.repo || ''}@${selectedPrefix || ''}`;

  useEffect(() => {
    if (prevScoutKeyRef.current !== currentScoutKey) {
      prevScoutKeyRef.current = currentScoutKey;
      setPrunedPaths(new Set(auxiliaryCandidates.map((c) => c.path)));
    } else if (autoPruneAuxiliary) {
      setPrunedPaths(new Set(auxiliaryCandidates.map((c) => c.path)));
    }
  }, [currentScoutKey, autoPruneAuxiliary, auxiliaryCandidates]);

  const handleConfirm = () => {
    const paths = Array.from(prunedPaths);
    wizardSetters.setExcludedPaths(paths);
    onConfirmDirectory();
  };

  const isCustomSelected = Boolean(recommendedPrefix && selectedPrefix !== recommendedPrefix);

  return (
    <div className="w-full bg-theme-surface border border-theme-border/70 rounded-2xl animate-in fade-in zoom-in-95 duration-200 text-left font-sans text-xs shadow-sm flex flex-col overflow-hidden">
      <div className="flex items-center px-4 py-3 border-b border-theme-border/40 bg-theme-bg/40">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={isGenerating}
            onClick={() => wizardFlow.goBackToInput()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-theme-muted hover:text-theme-foreground hover:bg-theme-border/30 rounded-lg border border-theme-border/40 transition-all cursor-pointer text-xs disabled:opacity-50 disabled:pointer-events-none"
          >
            <ArrowLeft size={13} />
            <span>{m.scout_feedback_back_to_edit()}</span>
          </button>
          <div className="h-3.5 w-px bg-theme-border/60" />
          <span className="text-theme-muted text-xs">
            {isCustomSelected ? m.scout_feedback_header_manual() : m.scout_feedback_header_auto()}
          </span>
        </div>
      </div>

      {parsedUrlInfo?.isBlobUrl && parsedUrlInfo.filePath && (
        <div className="px-4 py-2.5 bg-theme-bg/30 border-b border-theme-border/30 flex items-center justify-between text-xs">
          <span className="text-theme-muted">{m.scout_feedback_single_doc_targeting()}</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => setImportScopeMode('full_repo')}
              className={`px-2.5 py-1 rounded-md border text-xs cursor-pointer ${
                importScopeMode === 'full_repo' ? 'border-theme-primary bg-theme-primary/10 font-bold text-theme-primary' : 'border-theme-border text-theme-muted'
              } ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}
            >
              {m.scout_feedback_parse_full_repo()}
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => setImportScopeMode('single_doc')}
              className={`px-2.5 py-1 rounded-md border text-xs cursor-pointer ${
                importScopeMode === 'single_doc' ? 'border-theme-primary bg-theme-primary/10 font-bold text-theme-primary' : 'border-theme-border text-theme-muted'
              } ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}
            >
              {m.scout_feedback_parse_single_doc()}
            </button>
          </div>
        </div>
      )}

      {activeScopeVerdict && (
        <div className="px-4 py-2.5 border-b border-theme-border/40 bg-theme-primary/[0.03] flex flex-col gap-1.5 animate-in fade-in duration-150">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-theme-foreground">
              <Sparkles size={13} className="text-theme-primary shrink-0" />
              <span>{m.scout_ai_verdict_label()}</span>
              {activeScopeVerdict.targetRoot !== undefined && (
                <span className="text-micro font-normal text-theme-muted bg-theme-surface/80 px-2 py-0.5 rounded border border-theme-border/60 font-mono">
                  {m.scout_ai_target_label()}: {activeScopeVerdict.targetRoot ? `/${activeScopeVerdict.targetRoot.replace(/\/$/, '')}` : m.scout_feedback_root_dir()}
                </span>
              )}
            </div>

            <button
              type="button"
              disabled={isReAnalyzing || isGenerating}
              onClick={handleReAnalyzeScope}
              className="flex items-center gap-1.5 px-2.5 py-1 text-micro font-medium text-theme-primary hover:text-theme-primary/90 hover:bg-theme-primary/10 rounded-lg border border-theme-primary/30 transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]"
            >
              <RefreshCw size={11} className={isReAnalyzing ? 'animate-spin' : ''} />
              <span>{isReAnalyzing ? m.scout_ai_re_arbitrating() : m.scout_ai_re_arbitrate()}</span>
            </button>
          </div>

          <div className="text-caption text-theme-muted leading-relaxed pl-5 flex flex-col gap-1">
            {activeScopeVerdict.rationale && (
              <p className="text-theme-muted/90 select-text font-normal text-micro">
                {activeScopeVerdict.rationale}
              </p>
            )}
            {activeScopeVerdict.auxiliaryPaths && activeScopeVerdict.auxiliaryPaths.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap text-micro pt-0.5">
                <span className="text-theme-muted/70">{m.scout_ai_prune_label()} ({activeScopeVerdict.auxiliaryPaths.length}):</span>
                {activeScopeVerdict.auxiliaryPaths.map((p) => (
                  <span
                    key={p}
                    className="font-mono px-1.5 py-0.2 rounded bg-theme-border/30 text-theme-foreground/80 border border-theme-border/40"
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className={`p-4 flex flex-col flex-1 min-h-[250px] max-h-[300px] transition-opacity ${isGenerating ? 'pointer-events-none opacity-60' : ''}`}>
        <DirectoryCascadePicker
          dirTree={scoutData?.dirTree}
          selectedPrefix={selectedPrefix}
          onSelectPrefix={(prefix) => setSelectedPrefix(prefix)}
          borderless
          heightClass="h-[230px] md:h-[260px]"
        />
      </div>

      {showCustomPrune && candidateDirectories.length > 0 && (
        <div className="px-4 py-3 border-t border-theme-border/40 bg-theme-bg/60 flex flex-col gap-2 max-h-36 overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between text-caption font-semibold text-theme-foreground">
            <span>{m.scout_prune_title()}</span>
            <span className="text-theme-muted font-normal text-micro">{m.scout_prune_hint()}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {candidateDirectories.map((node) => {
              const isExcluded = prunedPaths.has(node.path);
              const isAux = scopeAuxiliarySet.has(node.path);
              return (
                <label
                  key={node.path}
                  className={`flex items-center justify-between p-1.5 rounded-lg border text-caption cursor-pointer transition-colors ${
                    isExcluded
                      ? 'border-theme-border/40 bg-theme-bg/40 opacity-60 text-theme-muted line-through'
                      : 'border-theme-border/60 bg-theme-surface hover:border-theme-primary/50 text-theme-foreground'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Checkbox
                      checked={!isExcluded}
                      onCheckedChange={() => {
                        setPrunedPaths((prev) => {
                          const next = new Set(prev);
                          if (next.has(node.path)) next.delete(node.path);
                          else next.add(node.path);
                          return next;
                        });
                      }}
                      className="border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer"
                    />
                    <span className="truncate font-mono">{node.name}</span>
                    {isAux && (
                      <span className="text-micro px-1 py-0.2 rounded bg-theme-surface border border-theme-border text-theme-muted">
                        {m.scout_prune_aux_tag()}
                      </span>
                    )}
                  </div>
                  <span className="text-micro text-theme-muted shrink-0 font-mono">
                    {node.mdCount ? `${node.mdCount} md` : ''}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-4 py-2.5 border-t border-theme-border/40 bg-theme-bg/30 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={isGenerating}
            onClick={() => setShowAiIntent((prev) => !prev)}
            className="flex items-center gap-1.5 text-xs font-serif font-bold text-theme-foreground hover:text-theme-primary transition-colors cursor-pointer disabled:opacity-50"
          >
            <Sparkles size={13} className="text-theme-primary" />
            <span>{m.scout_ai_pref_title()}</span>
            {customPrompt ? (
              <span className="text-micro px-1.5 py-0.2 rounded-full bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-sans font-medium">
                {m.scout_ai_pref_configured()}
              </span>
            ) : null}
            <span className="text-micro text-theme-muted font-normal font-sans ml-1">
              {showAiIntent ? m.common_collapse() : customPrompt ? m.scout_ai_pref_modify() : m.scout_ai_pref_customize()}
            </span>
          </button>
          {customPrompt && showAiIntent && (
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => wizardSetters.setCustomPrompt('')}
              className="text-micro text-theme-muted hover:text-rose-500 font-sans cursor-pointer disabled:opacity-50"
            >
              {m.scout_ai_pref_clear()}
            </button>
          )}
        </div>

        {showAiIntent && (
          <div className="space-y-2 pt-1 animate-in fade-in duration-200">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { label: m.scout_preset_arch_label(), text: m.scout_preset_arch_text() },
                { label: m.scout_preset_beginner_label(), text: m.scout_preset_beginner_text() },
                { label: m.scout_preset_practical_label(), text: m.scout_preset_practical_text() },
                { label: m.scout_preset_deep_label(), text: m.scout_preset_deep_text() },
              ].map((chip) => {
                const isActive = customPrompt.includes(chip.text);
                return (
                  <button
                    key={chip.label}
                    type="button"
                    disabled={isGenerating}
                    onClick={() => {
                      wizardSetters.setCustomPrompt(isActive ? '' : chip.text);
                    }}
                    className={`px-2 py-0.5 text-micro rounded-md border transition-all cursor-pointer disabled:opacity-50 ${
                      isActive
                        ? 'border-theme-primary bg-theme-primary/10 text-theme-primary font-bold'
                        : 'border-theme-border/60 text-theme-muted hover:text-theme-foreground hover:border-theme-border bg-theme-surface/50'
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>

            <textarea
              value={customPrompt}
              disabled={isGenerating}
              onChange={(e) => wizardSetters.setCustomPrompt(e.target.value)}
              placeholder={m.scout_ai_pref_placeholder()}
              rows={2}
              className="w-full text-xs font-sans bg-theme-bg border border-theme-border/60 rounded-lg p-2 resize-none outline-none focus:border-theme-primary text-theme-foreground custom-scrollbar disabled:opacity-50"
            />
          </div>
        )}
      </div>

      <div className="p-3.5 md:p-4 bg-theme-bg/90 border-t border-theme-border/50 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-inner">
        <div className="flex items-center gap-3.5 flex-wrap text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-theme-muted">{m.scout_root_label()}</span>
            <code className="font-mono font-bold text-xs text-theme-foreground bg-theme-surface px-2 py-0.5 rounded border border-theme-border/60">
              {targetDisplayName} ({targetPathDisplay})
            </code>
            {isCustomSelected && (
              <button
                type="button"
                disabled={isGenerating}
                onClick={() => setSelectedPrefix(recommendedPrefix)}
                className="text-caption text-theme-primary hover:underline ml-1 cursor-pointer disabled:opacity-50"
              >
                {m.scout_restore_recommended()}
              </button>
            )}
          </div>

          <div className="h-3.5 w-px bg-theme-border/60 hidden sm:block" />

          <div className="flex items-center gap-1.5 text-theme-muted">
            <span>
              {docFilesCount > 0 && m.scout_doc_count({ count: docFilesCount })}
              <strong className="text-theme-foreground font-mono">{codeFilesCount.toLocaleString()}</strong> {m.scout_code_files()}
            </span>
            {docFilesCount === 0 && codeFilesCount > 0 && (
              <span className="text-compact px-1.5 py-0.2 rounded bg-theme-border/30 text-theme-muted">{m.scout_pure_code_repo()}</span>
            )}
          </div>

          <div className="h-3.5 w-px bg-theme-border/60 hidden sm:block" />

          {auxiliaryCandidates.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-theme-foreground select-none">
                <Checkbox
                  checked={autoPruneAuxiliary}
                  onCheckedChange={(checked) => {
                    const isChecked = Boolean(checked);
                    wizardSetters.setAutoPruneAuxiliary(isChecked);
                    if (!isChecked) {
                      setPrunedPaths(new Set());
                    } else {
                      setPrunedPaths(new Set(auxiliaryCandidates.map((c) => c.path)));
                    }
                  }}
                  className="border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer"
                />
                <span>{m.scout_auto_prune()}</span>
              </label>
              <span className="text-caption text-theme-muted">
                (-{auxiliaryCandidates.length})
              </span>
            </div>
          )}
          {candidateDirectories.length > 0 && (
              <button
                type="button"
                onClick={() => setShowCustomPrune((prev) => !prev)}
                className="text-caption text-theme-primary hover:underline font-medium cursor-pointer"
              >
                {showCustomPrune ? m.common_collapse() : m.scout_custom()}
              </button>
            )}
        </div>

        <button
          type="button"
          disabled={isGenerating}
          onClick={handleConfirm}
          className="px-6 py-2.5 bg-theme-primary text-theme-primary-fg font-bold text-xs rounded-xl hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm active:scale-[0.98] shrink-0"
        >
          {isGenerating ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span>{m.scout_preparing_outline()}</span>
            </>
          ) : (
            <span>{m.common_next()}</span>
          )}
        </button>
      </div>

      {isGenerating && (
        <div className="p-3 bg-theme-bg/95 border-t border-theme-border/50 text-left flex flex-col gap-2 select-none pointer-events-none animate-in fade-in duration-150">
          <div className="flex items-center justify-between text-xs font-sans">
            <div className="flex items-center gap-2 min-w-0">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-theme-primary/60 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-theme-primary" />
              </span>
              <span className="font-mono text-micro text-theme-muted uppercase tracking-wider shrink-0">
                […]
              </span>
              <span className="text-micro font-medium text-theme-foreground truncate">
                {m.scout_preparing_outline()}
              </span>
            </div>
            <span className="font-mono text-micro text-theme-muted shrink-0 tabular-nums ml-2">
              {currentStageIndex}/{totalStages}
            </span>
          </div>

          <div className="font-mono text-micro text-theme-muted/80 leading-relaxed truncate pl-4 flex items-center gap-1.5">
            <span className="text-theme-border/80 font-sans select-none shrink-0">↳</span>
            <span className="truncate">{m.scout_stage_tree_desc()}</span>
          </div>

          <div className="grid grid-cols-4 gap-1.5 pt-0.5">
            {[1, 2, 3, 4].map((stepNum) => {
              const isCompleted = stepNum < currentStageIndex;
              const isCurrent = stepNum === currentStageIndex;
              return (
                <div
                  key={stepNum}
                  className={`h-1 rounded-full transition-all duration-300 ${
                    isCompleted
                      ? 'bg-theme-primary'
                      : isCurrent
                      ? 'bg-theme-primary/70 animate-pulse'
                      : 'bg-theme-border/40'
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
