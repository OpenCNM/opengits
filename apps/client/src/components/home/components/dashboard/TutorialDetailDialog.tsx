'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Globe,
  ExternalLink,
  ArrowRight,
  BookOpen,
  GitBranch,
  RotateCw,
  ArrowUpCircle,
  Crown,
  Loader2,
  CheckCircle2,
  Layers,
  Check,
  Plus,
  Trash2,
  FileText,
  Users,
  Zap,
  Sparkles,
  X,
  Eye,
  Star,
} from 'lucide-react';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { formatCompactNumber, formatCompactTokens, formatProgressPercent } from '@/lib/format';
import { isNativeWebDocMirror } from '@/lib/repository-origin';
import { isWebDocRepository, resolveLocalizedRepoDescription, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { RelayAvatarStack } from '@/components/update/RelayAvatarStack';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from '@/components/ui/dialog';
import { getLocalizedCategory } from './DashboardCategoryChips';
import { normalizeCategory, UNTAGGED_CATEGORIES, WEB_DOC_PREFIX } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveEditionChipDisplayLabel } from '@/lib/edition';
import { editionVisual, toggleEditionSave } from '@/components/repo/EditionChips';
import { RepoScoreRadarPanel } from '@/components/repo/RepoScoreRadar';
import { buildRadarAxes, getPedagogicalArchetype } from '@/components/repo/hooks/useRadarProfile';
import { AutoSyncSwitch } from '@/components/publish/AutoSyncSwitch';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUserCreditsStore } from '@/lib/stores/user-credits-store';
import * as m from '@/paraglide/messages';

export interface TutorialDetailDialogProps {
  repo: DisplayRepo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editions?: EditionChip[];
  activeEdition?: string;
  onEditionSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onCreateEdition?: (owner: string, repo: string) => void;
  onDeleted?: (chipId: string) => void;
  onPromoted?: (chip: EditionChip) => void;
  canManage?: boolean;
  onCheckUpdate?: (repo: DisplayRepo, targetEdition?: EditionChip) => Promise<void> | void;
  checkingRepoId?: string | null;
  onOpenUpdateDialog?: (target: { owner: string; repo: string; branch?: string; edition?: string }) => void;
  onOpenRelayWorkbench?: (repo: DisplayRepo) => void;
  onToggleSave?: (repo: DisplayRepo, autoFollow?: boolean) => Promise<void> | void;
  onToggleFavorite?: (repo: DisplayRepo) => Promise<void> | void;
  onStartImport?: (url?: string) => void;
  onSelectTab?: (tab: 'all' | 'trending' | 'review' | 'favorites') => void;
  onSearchTag?: (tag: string) => void;
}

function formatDate(dateValue?: Date | string | null): string {
  if (!dateValue) return '—';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

export function TutorialDetailDialog({
  repo,
  open,
  onOpenChange,
  editions,
  activeEdition,
  onEditionSavedChange,
  onCreateEdition,
  onDeleted,
  onPromoted,
  canManage,
  onCheckUpdate,
  checkingRepoId,
  onOpenUpdateDialog,
  onOpenRelayWorkbench,
  onToggleSave,
  onToggleFavorite,
  onStartImport,
  onSelectTab,
  onSearchTag,
}: TutorialDetailDialogProps) {
  const router = useRouter();
  const { locale } = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [selectedEditionKey, setSelectedEditionKey] = useState<string | null>(null);
  const userCredits = useUserCreditsStore((s) => s.data);
  const fetchCredits = useUserCreditsStore((s) => s.fetchCredits);
  const [trendingRecommendations, setTrendingRecommendations] = useState<
    Array<{ owner: string; repo: string; description: string; stars: number; language: string }>
  >([]);
  const [showInsufficientGuidance, setShowInsufficientGuidance] = useState(false);
  const [showConfirmJoin, setShowConfirmJoin] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const saveLockRef = React.useRef(false);
  const [isReReviewing, setIsReReviewing] = useState(false);
  const [localReviewLlm, setLocalReviewLlm] = useState<Record<string, any>>({});
  const [localReReviewRemaining, setLocalReReviewRemaining] = useState<Record<string, number>>({});
  const [localReviewHistory, setLocalReviewHistory] = useState<Record<string, any[]>>({});

  React.useEffect(() => {
    if (!open) return;
    fetchCredits();

    api.get<{ recommendations: Array<{ owner: string; repo: string; description: string; stars: number; language: string }> }>(
      '/api/repos/trending-recommendations'
    )
      .then((res) => {
        if (res?.recommendations) setTrendingRecommendations(res.recommendations);
      })
      .catch(() => {});
  }, [open, fetchCredits]);

  const [liveEditions, setLiveEditions] = useState<EditionChip[] | null>(null);

  React.useEffect(() => {
    setSelectedEditionKey(null);
    setShowInsufficientGuidance(false);
    setShowConfirmJoin(false);
    setLiveEditions(null);
    setIsReReviewing(false);
    setLocalReviewLlm({});
    setLocalReReviewRemaining({});
    saveLockRef.current = false;
    setIsSaving(false);
  }, [repo?.id, open]);

  React.useEffect(() => {
    if (!open || !repo) return;
    if (editions && editions.length > 1) return;

    api.get<{ editions?: any[] }>(`/api/ingest-status/${repo.owner}/${repo.repo}`)
      .then((res) => {
        const rawEditions = res?.editions;
        if (Array.isArray(rawEditions) && rawEditions.length > 1) {
          const mapped: EditionChip[] = rawEditions.map((e) => ({
            id: e.id,
            edition: e.edition ?? '',
            label: e.label || (e.edition ? `${m.edition_label_custom()} ${e.edition}` : m.edition_label_standard()),
            presetId: e.presetId ?? null,
            isDefault: Boolean(e.isDefault || !e.edition),
            isSaved: e.isSaved ?? false,
            branch: e.branch || repo.branch || ENGINE_CONFIG.defaultBranch,
            docUrl: `/docs/${repo.owner}/${repo.repo}${e.edition ? `?edition=${encodeURIComponent(e.edition)}` : ''}`,
            transcriptionModels: e.transcriptionModels || [],
            chapterCount: e.chapterCount ?? (repo.chapterCount || 0),
            processedDocsCount: e.processedDocsCount ?? (repo.processedDocsCount || 0),
            progress: e.progress ?? 0,
            isPublic: e.isPublic ?? true,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
            relayEnabled: e.relayEnabled ?? false,
            isFullyTranscribed: e.isFullyTranscribed ?? ((e.chapterCount ?? 0) > 0 && (e.processedDocsCount ?? 0) >= (e.chapterCount ?? 0)),
            relay: e.relay ?? null,
            reviewPipeline: e.reviewPipeline ?? null,
            reviewLlm: e.reviewLlm ?? null,
            reviewAppealsRemaining: e.reviewAppealsRemaining ?? 3,
          }));
          setLiveEditions(mapped);
        }
      })
      .catch(() => {});
  }, [open, repo, editions]);

  if (!repo) return null;

  const effectiveEditions = (editions && editions.length > 1) ? editions : (liveEditions || editions);

  const isWebDoc = isWebDocRepository(repo);
  const cleanTitle = resolveRepositoryDisplayName(repo);
  const localizedDescription = resolveLocalizedRepoDescription(repo, locale);

  const originUrl = isWebDoc
    ? (repo.repoProfile?.originalUrl || `https://${repo.repo.replace(new RegExp(`^${WEB_DOC_PREFIX}`), '')}`)
    : `https://github.com/${repo.owner}/${repo.repo}`;

  const docSlug = repo.lastReadPath ? repo.lastReadPath.replace(/\.mdx?$/, '') : '';
  const docUrl = `/docs/${repo.owner}/${repo.repo}${docSlug ? '/' + docSlug : ''}`;

  const normalizedRepoCategory = normalizeCategory(repo.category);
  const categoryLabel = getLocalizedCategory(repo.category || '');
  const showCategoryTag = Boolean(repo.category)
    && !UNTAGGED_CATEGORIES.has(normalizedRepoCategory)
    && !isWebDoc;

  const activeKey =
    selectedEditionKey ??
    activeEdition ??
    (repo.edition !== undefined && repo.edition !== null
      ? repo.edition
      : (effectiveEditions && effectiveEditions.length > 0 ? effectiveEditions[0]?.edition : ''));

  const selectedChip =
    effectiveEditions && effectiveEditions.length > 0
      ? (effectiveEditions.find((e) => e.edition === activeKey) ?? effectiveEditions[0])
      : null;
  const isNativeMirror = isNativeWebDocMirror({
    ...repo,
    edition: selectedChip ? selectedChip.edition : repo.edition,
  });

  const commitSha = repo.gitSha || repo.importedSha;
  const repoBranch = repo.branch || ENGINE_CONFIG.defaultBranch;
  const repoCommitSha = commitSha;
  const repoHasUpdate = Boolean(repo.hasUpdate || repo.hasUpstreamUpdate);
  const isCheckingRepo = checkingRepoId === repo.id;

  const effectiveBranch = selectedChip?.branch || repo.branch || ENGINE_CONFIG.defaultBranch;
  const effectiveCommitSha = selectedChip?.gitSha || selectedChip?.importedSha || commitSha;
  const effectiveHasUpdate = Boolean(
    selectedChip ? selectedChip.hasUpdate : repoHasUpdate
  );
  const effectiveDate =
    selectedChip?.updatedAt || selectedChip?.createdAt || repo.updatedAt || repo.createdAt;
  const isCheckingCurrent =
    checkingRepoId === (selectedChip?.id || repo.id);

  const effectiveChapterCount = selectedChip?.chapterCount ?? (repo.chapterCount || repo.processedDocsCount || repo.repoProfile?.pageCount || '—');
  const effectiveProgress = selectedChip ? (selectedChip.progress ?? 0) : (repo.progress || 0);
  const effectiveModels =
    (selectedChip?.transcriptionModels && selectedChip.transcriptionModels.length > 0)
      ? selectedChip.transcriptionModels
      : (repo.transcriptionModels || []);
  const effectiveTokens = selectedChip?.transcriptionTokens ?? repo.transcriptionTokens ?? 0;
  const effectiveDocUrl = selectedChip?.docUrl || docUrl;

  const effectiveEditionLabel = selectedChip
    ? resolveEditionChipDisplayLabel(selectedChip)
    : '';

  const isSelectedFullyTranscribed = selectedChip
    ? (typeof selectedChip.isFullyTranscribed === 'boolean'
        ? selectedChip.isFullyTranscribed
        : (selectedChip.chapterCount > 0 && selectedChip.processedDocsCount >= selectedChip.chapterCount))
    : Boolean(repo.isFullyTranscribed || (repo.chapterCount > 0 && repo.processedDocsCount >= repo.chapterCount));

  const effectiveProcessedDocsCount = selectedChip
    ? (selectedChip.processedDocsCount ?? 0)
    : (repo.processedDocsCount ?? 0);

  const effectiveChapterTotal = typeof effectiveChapterCount === 'number'
    ? effectiveChapterCount
    : (selectedChip?.chapterCount ?? repo.chapterCount ?? 0);

  const effectiveTranscriptionPercent = effectiveChapterTotal > 0
    ? Math.min(100, Math.round((effectiveProcessedDocsCount / effectiveChapterTotal) * 100))
    : 0;

  const effectiveRelay = isSelectedFullyTranscribed
    ? null
    : selectedChip
      ? (selectedChip.relay ?? ((selectedChip.isDefault || selectedChip.id === repo.id) ? (repo.relay ?? null) : null))
      : (!repo.isFullyTranscribed && repo.relay ? repo.relay : null);

  const effectiveRelayEnabled = isSelectedFullyTranscribed
    ? false
    : selectedChip
      ? (selectedChip.relayEnabled ?? ((selectedChip.isDefault || selectedChip.id === repo.id) ? Boolean(repo.relayEnabled) : false))
      : Boolean(repo.relayEnabled);

  const isRelayInProgress = Boolean(
    !isSelectedFullyTranscribed && (effectiveRelayEnabled || effectiveRelay) && effectiveRelay && effectiveRelay.done < effectiveRelay.total
  );

  const effectiveRelayRepo = (!selectedChip || selectedChip.id === repo.id)
    ? {
        ...repo,
        relay: effectiveRelay,
        relayEnabled: effectiveRelayEnabled,
        isFullyTranscribed: isSelectedFullyTranscribed,
      }
    : {
        ...repo,
        id: selectedChip.id,
        edition: selectedChip.edition,
        branch: selectedChip.branch || repo.branch,
        relay: effectiveRelay,
        relayEnabled: effectiveRelayEnabled,
        chapterCount: selectedChip.chapterCount,
        processedDocsCount: selectedChip.processedDocsCount,
        isFullyTranscribed: isSelectedFullyTranscribed,
      };

  const rawStars =
    repo.starCount ??
    repo.stargazersCount ??
    repo.stargazers_count ??
    repo.repoProfile?.starCount ??
    repo.repoProfile?.stargazersCount ??
    repo.repoProfile?.stars ??
    repo.repoProfile?.stargazers_count;

  const isDefaultSelected = !selectedChip || selectedChip.isDefault || selectedChip.id === repo.id;
  const targetEditionKey = selectedChip?.edition ?? repo.edition ?? '';
  const activeReviewPipeline = isSelectedFullyTranscribed
    ? ((selectedChip?.reviewPipeline ?? (isDefaultSelected ? repo.reviewPipeline : null)) as any)
    : null;
  const activeReviewLlm = isSelectedFullyTranscribed
    ? ((localReviewLlm[targetEditionKey] ?? selectedChip?.reviewLlm ?? (isDefaultSelected ? repo.reviewLlm : null)) as any)
    : null;

  const activeReReviewRemaining =
    localReReviewRemaining[targetEditionKey] ??
    selectedChip?.reviewAppealsRemaining ??
    (repo.repoProfile as any)?.reviewAppealsRemaining ??
    3;

  const targetProfile = ((selectedChip as any)?.repoProfile ?? repo.repoProfile) as Record<string, unknown> | undefined;
  const initialHistory = Array.isArray(targetProfile?.reviewHistory) ? (targetProfile.reviewHistory as any[]) : [];
  const activeReviewHistory = localReviewHistory[targetEditionKey] ?? initialHistory;

  const handleReReview = async () => {
    if (isReReviewing || activeReReviewRemaining <= 0) return;
    setIsReReviewing(true);
    try {
      const res = await api.post<{
        success: boolean;
        reviewLlm: any;
        reviewAppealsRemaining: number;
        overallScore: number;
        historyItem?: any;
        message: string;
      }>('/api/repos/re-review', {
        repositoryId: selectedChip?.id ?? repo.id,
        owner: repo.owner,
        repo: repo.repo,
        edition: selectedChip?.edition ?? repo.edition ?? '',
      });
      if (res?.reviewLlm) {
        setLocalReviewLlm((prev) => ({ ...prev, [targetEditionKey]: res.reviewLlm }));
        setLocalReReviewRemaining((prev) => ({ ...prev, [targetEditionKey]: res.reviewAppealsRemaining }));
        if (res.historyItem) {
          setLocalReviewHistory((prev) => ({
            ...prev,
            [targetEditionKey]: [res.historyItem, ...(prev[targetEditionKey] || initialHistory)],
          }));
        }
        toastManager.add({ type: 'success', title: res.message || m.tutorial_re_review_success() });
      }
    } catch (err: any) {
      toastManager.add({ type: 'error', title: err?.message || m.tutorial_re_review_failed() });
    } finally {
      setIsReReviewing(false);
    }
  };

  const isMaintainer = Boolean(canManage ?? repo.canManage);
  const handleReReviewClick = () => {
    if (!isMaintainer) {
      toastManager.add({
        type: 'error',
        title: m.tutorial_re_review_permission(),
      });
      return;
    }
    handleReReview();
  };

  const rawLlmScore = activeReviewLlm?.unavailable ? null : (activeReviewLlm?.overallScore as number | null | undefined);
  const normLlmScore = rawLlmScore != null ? (rawLlmScore <= 10 && rawLlmScore > 0 ? Math.round(rawLlmScore * 10) : Math.round(rawLlmScore)) : null;
  const pipeTotal = typeof activeReviewPipeline?.total === 'number' && activeReviewPipeline.total > 0 ? Math.round(activeReviewPipeline.total) : null;
  const activeEditionScore = isSelectedFullyTranscribed
    ? (normLlmScore ?? pipeTotal ?? (isDefaultSelected && typeof repo.recScore === 'number' ? Math.round(repo.recScore) : undefined))
    : undefined;

  const highlight = isSelectedFullyTranscribed ? (activeReviewLlm?.coreHighlight || activeReviewLlm?.summary) : undefined;
  const audience = isSelectedFullyTranscribed ? activeReviewLlm?.targetAudience : undefined;

  const fee = repo.shelfFeeEstimate ?? 0;
  const userBalance = userCredits?.creditBalance ?? 0;
  const hasEnoughBalance = userBalance >= fee;
  const gap = Math.max(0, fee - userBalance);
  const remainingChapters = Math.max(
    1,
    (effectiveRelay?.total ?? (typeof effectiveChapterCount === 'number' ? effectiveChapterCount : repo.chapterCount) ?? 1) -
      (effectiveRelay?.done ?? selectedChip?.processedDocsCount ?? repo.processedDocsCount ?? 0)
  );

  const handleToggleSaveClick = async () => {
    if (!repo || !onToggleSave || repo.isSaved || isSaving || saveLockRef.current) return;
    saveLockRef.current = true;
    setIsSaving(true);
    try {
      await onToggleSave(repo, autoFollow);
    } finally {
      saveLockRef.current = false;
      setIsSaving(false);
    }
  };

  const handleToggle = async (chip: EditionChip) => {
    setBusyId(chip.id);
    try {
      const ok = await toggleEditionSave(chip);
      if (ok) onEditionSavedChange?.(chip, !chip.isSaved);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (chip: EditionChip) => {
    const confirmMsg = `${m.common_delete()}「${chip.label}」？`;
    if (!window.confirm(confirmMsg)) return;

    setDeletingId(chip.id);
    try {
      await api.delete(`/api/repos?id=${chip.id}&global=true`);
      toastManager.add({ type: 'success', title: m.toast_project_deleted() });
      onDeleted?.(chip.id);
      router.refresh();
      onOpenChange(false);
    } catch (err: any) {
      toastManager.add({
        type: 'error',
        title: m.common_delete_failed(),
        description: err?.message,
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handlePromote = async (chip: EditionChip) => {
    const confirmMsg = m.edition_promote_confirm({ label: chip.label });
    if (!window.confirm(confirmMsg)) return;

    setPromotingId(chip.id);
    try {
      await api.post('/api/repos/promote-edition', { repoId: chip.id });
      toastManager.add({ type: 'success', title: m.edition_promote_success() });
      onPromoted?.(chip);
      onOpenChange(false);
      const cleanUrl = chip.docUrl.split('?')[0];
      window.location.href = cleanUrl;
    } catch (err: any) {
      toastManager.add({
        type: 'error',
        title: m.edition_promote_failed(),
        description: err?.message,
      });
    } finally {
      setPromotingId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        finalFocus={(closeType) => closeType === 'keyboard'}
        className="max-w-2xl sm:max-w-3xl lg:max-w-4xl w-full bg-theme-surface border border-theme-border rounded-2xl sm:rounded-3xl shadow-2xl p-0 overflow-hidden font-sans"
      >
        <DialogHeader className="px-5 py-3 sm:px-6 sm:py-3.5 border-b border-theme-border/60 bg-theme-bg/40 relative pr-14">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                {isWebDoc ? (
                  <Globe className="w-5 h-5 text-sky-500 shrink-0" />
                ) : (
                  <GithubIcon className="w-5 h-5 text-theme-primary shrink-0" />
                )}
                <DialogTitle className="text-lg sm:text-xl font-bold font-heading text-theme-foreground truncate">
                  {isWebDoc ? (
                    cleanTitle
                  ) : (
                    <span className="font-mono">{repo.owner}/<strong className="font-bold">{repo.repo}</strong></span>
                  )}
                </DialogTitle>
              </div>

              {repoHasUpdate ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20 text-micro font-sans font-medium shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {m.dashboard_upstream_has_update()}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-micro font-sans font-medium shrink-0">
                  <CheckCircle2 className="w-3 h-3" />
                  {m.toast_already_latest()}
                </span>
              )}

              {onCheckUpdate && (
                <button
                  type="button"
                  disabled={isCheckingRepo}
                  onClick={() => onCheckUpdate(repo)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-theme-surface border border-theme-border/80 hover:border-theme-foreground/50 text-micro font-sans font-medium text-theme-foreground hover:bg-theme-border/20 transition-all cursor-pointer disabled:opacity-50 shadow-2xs active:scale-[0.98] shrink-0"
                  title={m.tutorial_check_upstream_title()}
                >
                  <RotateCw className={cn('w-3 h-3', isCheckingRepo && 'animate-spin text-theme-primary')} />
                  <span>{isCheckingRepo ? m.dashboard_checking() : m.update_check()}</span>
                </button>
              )}

              {repoHasUpdate && onOpenUpdateDialog && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenUpdateDialog({
                      owner: repo.owner,
                      repo: repo.repo,
                      branch: repoBranch,
                    });
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-theme-primary text-theme-primary-fg text-micro font-sans font-bold hover:brightness-110 active:scale-95 transition-all shadow-2xs cursor-pointer shrink-0"
                >
                  <ArrowUpCircle className="w-3 h-3" />
                  <span>{m.update_confirm_affected_chapters()}</span>
                </button>
              )}

              {Boolean(canManage ?? repo.canManage) && (
                <AutoSyncSwitch
                  owner={repo.owner}
                  repo={repo.repo}
                  enabled={Boolean(repo.autoSyncEnabled)}
                  onChange={(next) => {
                    repo.autoSyncEnabled = next;
                  }}
                />
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={originUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 font-mono text-xs inline-flex items-center gap-1 transition-colors cursor-pointer group/link hover:underline decoration-sky-400/50 truncate max-w-full"
                title={isWebDoc ? m.github_origin_open_original_site() : m.github_origin_open_github_repo()}
              >
                <span className="truncate">{originUrl}</span>
                <ExternalLink className="w-3 h-3 group-hover/link:translate-x-0.5 transition-transform shrink-0" />
              </a>

              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-theme-surface border border-theme-border/80 text-micro text-theme-foreground/90 font-mono shadow-2xs shrink-0">
                {isWebDoc ? (
                  <Globe className="w-3 h-3 text-sky-500 shrink-0" />
                ) : (
                  <GitBranch className="w-3 h-3 text-theme-primary/80 shrink-0" />
                )}
                <span className="font-semibold">
                  {isWebDoc ? m.web_doc_snapshot() : repoBranch}
                </span>
                {repoCommitSha && (
                  <span className="text-theme-muted font-normal">@{repoCommitSha.slice(0, 7)}</span>
                )}
              </div>

              {showCategoryTag && (
                <span className="px-2 py-0.2 rounded bg-theme-bg border border-theme-border/80 text-micro text-theme-muted font-mono shrink-0">
                  {categoryLabel}
                </span>
              )}
              {repo.tags && repo.tags.length > 0 && (
                repo.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      onSearchTag?.(tag);
                      onOpenChange(false);
                    }}
                    className="inline-flex items-center px-1.5 py-0.2 rounded bg-theme-surface border border-theme-border/80 text-micro font-mono text-theme-muted hover:text-theme-primary hover:border-theme-primary/40 hover:bg-theme-primary/5 transition-colors cursor-pointer shrink-0"
                    title={m.tutorial_search_tag_title({ tag })}
                  >
                    #{tag}
                  </button>
                ))
              )}
              {effectiveRelay && effectiveRelay.done < effectiveRelay.total && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.2 rounded bg-theme-surface border border-theme-border/80 text-micro font-mono text-theme-foreground shrink-0 shadow-2xs"
                  title={m.dashboard_relay_progress_title({ done: effectiveRelay.done, total: effectiveRelay.total })}
                >
                  <Users className="w-3 h-3 text-theme-foreground/70 shrink-0" />
                  <span className="font-semibold">{m.dashboard_relay_tag({ done: effectiveRelay.done, total: effectiveRelay.total })}</span>
                  {effectiveRelay.inProgress > 0 && (
                    <span className="relative flex h-1.5 w-1.5 ml-0.5" title={m.relay_chapters_in_progress({ count: effectiveRelay.inProgress })}>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="p-4 sm:p-5 space-y-2.5 max-h-[85vh] overflow-y-auto custom-scrollbar">
          {!isSelectedFullyTranscribed ? (
            <div className="p-4 sm:p-5 rounded-xl bg-theme-bg/60 border border-theme-border/50 space-y-3 font-sans">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500 border border-amber-500/20 shrink-0">
                    <RotateCw className="w-4 h-4 animate-spin" />
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-theme-foreground">
                      {m.tutorial_transcribing_waiting_title()}
                    </span>
                    {effectiveEditionLabel && (
                      <span className="font-mono text-micro px-2 py-0.5 rounded bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-bold shrink-0">
                        {effectiveEditionLabel}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 font-mono text-xs shrink-0">
                  <span className="text-theme-muted font-medium">
                    {m.tutorial_transcribed_progress({
                      done: effectiveProcessedDocsCount,
                      total: effectiveChapterTotal,
                    })}
                  </span>
                  {effectiveChapterTotal > 0 && (
                    <span className="font-bold text-amber-500">
                      ({effectiveTranscriptionPercent}%)
                    </span>
                  )}
                </div>
              </div>

              <div className="h-2 w-full rounded-full bg-theme-surface border border-theme-border/40 overflow-hidden">
                {effectiveChapterTotal > 0 ? (
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-500"
                    style={{ width: `${Math.min(Math.max(effectiveTranscriptionPercent, 4), 100)}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-amber-500/70 animate-pulse" />
                )}
              </div>

              <p className="text-xs text-theme-muted leading-relaxed font-sans">
                {m.tutorial_transcribing_waiting_desc()}
              </p>
            </div>
          ) : !isWebDoc ? (
            <RepoScoreRadarPanel
              reviewPipeline={activeReviewPipeline}
              reviewLlm={activeReviewLlm}
              recScore={activeEditionScore}
              editionLabel={selectedChip && effectiveEditions && effectiveEditions.length > 1 ? resolveEditionChipDisplayLabel(selectedChip) : undefined}
              compact
              pendingReview={true}
              reReviewRemaining={activeReReviewRemaining}
              onReReview={isMaintainer ? handleReReviewClick : undefined}
              isReReviewing={isReReviewing}
              reviewHistory={activeReviewHistory}
            />
          ) : (highlight || audience) ? (
            <div className="p-3 rounded-xl bg-theme-bg/60 border border-theme-border/40 text-xs space-y-2 font-sans">
              {highlight && (
                <div className="leading-relaxed">
                  <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded text-micro font-bold bg-theme-primary/10 text-theme-primary select-none align-baseline">
                    {m.radar_highlight_badge()}
                  </span>
                  <span className="font-medium text-theme-foreground/90">{highlight}</span>
                </div>
              )}
              {audience && (
                <div className="leading-relaxed">
                  <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded text-micro font-bold bg-theme-bg border border-theme-border text-theme-muted select-none align-baseline">
                    {m.radar_audience_badge()}
                  </span>
                  <span className="font-medium text-theme-foreground/80">{audience}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 sm:p-3.5 rounded-xl bg-theme-bg/60 border border-theme-border/50 text-xs flex items-center justify-between gap-2 font-sans">
              <div className="flex items-center gap-2">
                <RotateCw className="w-3.5 h-3.5 animate-spin text-amber-500 shrink-0" />
                <span className="font-semibold text-theme-foreground">{m.radar_status_evaluating()}</span>
              </div>
            </div>
          )}

          <div className="px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl bg-theme-bg/60 border border-theme-border/50 flex items-center justify-between gap-2 overflow-x-auto custom-scrollbar text-xs font-mono">
            <div className="flex items-center gap-2.5 sm:gap-3.5 flex-nowrap shrink-0">
              <div className="flex items-center gap-1 text-theme-foreground" title={m.github_origin_docs_label()}>
                <FileText className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                <span className="font-bold">
                  {typeof effectiveChapterCount === 'number'
                    ? m.github_origin_docs_count({ count: effectiveChapterCount })
                    : effectiveChapterCount}
                </span>
              </div>

              {!isNativeMirror && (
                <>
                  <span className="text-theme-border/60 select-none">·</span>

                  <div className="flex items-center gap-1 text-theme-foreground" title={m.nav_reading_progress()}>
                    <BookOpen className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                    <span className="font-bold">{effectiveProgress > 0 ? m.tutorial_reading_progress({ progress: effectiveProgress }) : m.tutorial_unread()}</span>
                  </div>
                </>
              )}

              <span className="text-theme-border/60 select-none">·</span>

              <div className="flex items-center gap-1 text-theme-foreground" title={m.tutorial_detail_views()}>
                <Eye className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                <span className="font-bold">{m.tutorial_views_count({ count: formatCompactNumber(repo.views || 0) })}</span>
              </div>

              <span className="text-theme-border/60 select-none">·</span>

              {!isWebDoc ? (
                <div className="flex items-center gap-1 text-theme-foreground" title="GitHub Stars">
                  <Star className="w-3.5 h-3.5 text-theme-muted/70 shrink-0" />
                  <span className="font-bold">
                    {typeof rawStars === 'number' ? formatCompactNumber(rawStars) : '0'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1 text-theme-foreground" title={m.tutorial_detail_mcp_calls()}>
                  <Zap className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                  <span className="font-bold">
                    {formatCompactNumber(repo.mcpCallCount || 0)} MCP
                  </span>
                </div>
              )}

              <span className="text-theme-border/60 select-none">·</span>

              <button
                type="button"
                onClick={() => onToggleFavorite?.(repo)}
                disabled={!onToggleFavorite}
                title={
                  repo.isFavorited ? m.dashboard_unfavorite_action() : m.dashboard_favorite_action()
                }
                className={`group/fav flex items-center gap-1 transition-colors rounded px-1 py-0.5 -mx-1 ${
                  onToggleFavorite
                    ? 'cursor-pointer hover:bg-theme-surface text-theme-foreground'
                    : 'cursor-default text-theme-foreground'
                }`}
              >
                <Star
                  className={`w-3.5 h-3.5 shrink-0 transition-colors ${
                    repo.isFavorited
                      ? 'text-amber-500 fill-amber-500/20'
                      : 'text-theme-muted/60 group-hover/fav:text-amber-500/80'
                  }`}
                />
                <span className="font-bold">
                  {formatCompactNumber(repo.favoriteCount || 0)}
                </span>
              </button>

              <span className="text-theme-border/60 select-none">·</span>

              <div className="flex items-center gap-1 text-theme-foreground" title={m.tutorial_detail_shelf_add()}>
                <Users className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                <span className="font-bold">
                  {m.tutorial_studying_count({ count: formatCompactNumber(repo.savedCount || 0) })}
                </span>
                {fee > 0 ? (
                  <span className="text-micro font-mono text-theme-muted px-1.5 py-0.2 rounded bg-theme-surface border border-theme-border/60">
                    {m.shelf_fee_card_badge({ count: fee })}
                  </span>
                ) : (
                  <span className="text-micro font-mono text-emerald-600 dark:text-emerald-400 px-1.5 py-0.2 rounded bg-emerald-500/10 border border-emerald-500/20">
                    {m.shelf_fee_free_badge()}
                  </span>
                )}
              </div>

              {Boolean(effectiveTokens && effectiveTokens > 0) && (
                <>
                  <span className="text-theme-border/60 select-none">·</span>
                  <div className="flex items-center gap-1 text-theme-muted" title={m.tutorial_transcription_tokens_label()}>
                    <Zap className="w-3 h-3 text-theme-primary shrink-0" />
                    <span className="font-bold text-theme-foreground">
                      {formatCompactTokens(effectiveTokens)}
                    </span>
                    <span>Token</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {effectiveEditions && effectiveEditions.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-theme-primary" />
                  <span>{m.edition_section_title()}</span>
                </p>
                <span className="text-micro font-mono text-theme-muted">
                  ({effectiveEditions.length})
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {effectiveEditions.map((chip) => {
                  const { Icon, toneClass } = editionVisual(chip.presetId);
                  const isFullyTranscribed = chip.chapterCount > 0 && chip.processedDocsCount >= chip.chapterCount;
                  const isTranscribing = chip.chapterCount > 0 && chip.processedDocsCount > 0 && chip.processedDocsCount < chip.chapterCount;
                  const transcriptionPercent = chip.chapterCount > 0
                    ? Math.round((chip.processedDocsCount / chip.chapterCount) * 100)
                    : 0;

                  const readingProgress = chip.progress ?? 0;
                  const isChipNativeWebMirror = isNativeWebDocMirror({
                    ...repo,
                    edition: chip.edition,
                  });
                  const isSelected = chip.edition === activeKey;
                  const isCustom = !chip.isDefault;

                  const modelName = chip.transcriptionModels?.[0] || '';
                  const chipDate = formatDate(chip.createdAt || chip.updatedAt);
                  const chipBranch = chip.branch || ENGINE_CONFIG.defaultBranch;
                  const chipCommitSha = chip.gitSha || chip.importedSha;

                  const displayLabel = resolveEditionChipDisplayLabel(chip);

                  const chipHasScores =
                    isFullyTranscribed &&
                    Boolean(
                      chip.reviewLlm &&
                      !(chip.reviewLlm as any).unavailable &&
                      (
                        (Array.isArray((chip.reviewLlm as any).dimensions) && (chip.reviewLlm as any).dimensions.length > 0) ||
                        (typeof (chip.reviewLlm as any).overallScore === 'number' && (chip.reviewLlm as any).overallScore > 0)
                      )
                    );
                  const chipAxes = chipHasScores
                    ? buildRadarAxes(chip.reviewPipeline as any, chip.reviewLlm as any)
                    : [];
                  const chipArchetype = chipAxes.length > 0
                    ? getPedagogicalArchetype(chipAxes, (chip.reviewLlm as any)?.archetype)
                    : null;

                  return (
                    <div
                      key={chip.id}
                      onClick={() => setSelectedEditionKey(chip.edition)}
                      className={cn(
                        'group rounded-xl border p-2.5 sm:p-3 flex flex-col justify-between transition-all space-y-1.5 cursor-pointer relative',
                        isSelected
                          ? 'border-theme-primary/80 bg-theme-primary/[0.04] shadow-xs ring-1 ring-theme-primary/25'
                          : 'border-theme-border/60 bg-theme-bg/60 hover:bg-theme-surface/70 hover:border-theme-primary/30'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className={cn('p-1 rounded-md shrink-0 border', toneClass)}>
                            <Icon className="w-3 h-3" />
                          </span>
                          <div className="min-w-0 flex items-center gap-1.5 flex-wrap flex-1">
                            <span className="font-mono font-bold text-xs text-theme-foreground truncate" title={displayLabel}>
                              {displayLabel}
                            </span>
                            {chip.isDefault && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-micro font-sans font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shrink-0"
                                title={m.version_trial_current_badge()}
                              >
                                <Crown className="w-2.5 h-2.5" />
                                <span>{m.version_trial_current_badge()}</span>
                              </span>
                            )}
                            {chipArchetype && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.2 rounded text-micro font-sans font-semibold bg-theme-surface text-theme-primary border border-theme-primary/30 shrink-0 shadow-2xs"
                                title={chipArchetype.desc}
                              >
                                <span>{chipArchetype.label}</span>
                              </span>
                            )}
                          </div>
                        </div>
                        {isSelected ? (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-micro font-sans font-semibold bg-theme-primary text-theme-primary-fg shadow-2xs shrink-0">
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                            <span>{m.edition_state_selected()}</span>
                          </span>
                        ) : (
                          <span className="text-micro text-theme-muted group-hover:text-theme-foreground transition-colors shrink-0">
                            {m.edition_action_switch()}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-caption font-mono">
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-theme-surface border border-theme-border/70 text-micro text-theme-foreground/90 font-mono shadow-2xs">
                          {isWebDoc ? (
                            <Globe className="w-3 h-3 text-sky-500 shrink-0" />
                          ) : (
                            <GitBranch className="w-3 h-3 text-theme-primary/80 shrink-0" />
                          )}
                          <span className="font-semibold">
                            {isWebDoc ? m.web_doc_snapshot() : chipBranch}
                          </span>
                          {chipCommitSha && (
                            <span className="text-theme-primary font-medium">@{chipCommitSha.slice(0, 7)}</span>
                          )}
                          {chipDate && chipDate !== '—' && (
                            <>
                              <span className="text-theme-border/70 select-none">·</span>
                              <span className="text-theme-muted font-normal">{chipDate}</span>
                            </>
                          )}
                        </div>
                        {chip.hasUpdate && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 text-micro font-sans font-medium shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            {m.dashboard_upstream_has_update()}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-caption text-theme-muted font-mono pt-1 border-t border-theme-border/30">
                        <div className="flex items-center gap-1.5">
                          <span>{chip.chapterCount > 0 ? m.common_count_chapters({ count: chip.chapterCount }) : ''}</span>
                          {isFullyTranscribed ? (
                            !isChipNativeWebMirror && (
                              <>
                                <span className="text-theme-border/60">·</span>
                                <span>{readingProgress > 0 ? m.tutorial_reading_progress({ progress: readingProgress }) : m.tutorial_unread()}</span>
                                {readingProgress > 0 && (
                                  <div className="w-12 h-1 bg-theme-surface rounded-full overflow-hidden border border-theme-border/40 inline-block align-middle">
                                    <div
                                      className="h-full bg-theme-primary rounded-full transition-all"
                                      style={{ width: `${Math.min(Math.max(readingProgress, 0), 100)}%` }}
                                    />
                                  </div>
                                )}
                              </>
                            )
                          ) : isTranscribing ? (
                            <>
                              <span className="text-theme-border/60">·</span>
                              <span>{m.tutorial_transcribed_progress({ done: chip.processedDocsCount, total: chip.chapterCount })}</span>
                              <div className="w-12 h-1 bg-theme-surface rounded-full overflow-hidden border border-theme-border/40 inline-block align-middle">
                                <div
                                  className="h-full bg-amber-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(Math.max(transcriptionPercent, 0), 100)}%` }}
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <span className="text-theme-border/60">·</span>
                              <span className="text-theme-muted">{m.tutorial_untranscribed_details()}</span>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {isTranscribing ? (
                            <span className="text-amber-500 font-sans font-medium text-micro flex items-center gap-1">
                              <RotateCw className="w-3 h-3 animate-spin" />
                              {m.relay_transcribing()}
                            </span>
                          ) : !isFullyTranscribed ? (
                            <span className="text-sky-500 font-sans font-medium text-micro flex items-center gap-1">
                              <FileText className="w-3 h-3" />
                              {m.tutorial_untranscribed_badge()}
                            </span>
                          ) : null}

                          <div className="flex items-center gap-0.5 ml-0.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              disabled={busyId === chip.id}
                              onClick={() => handleToggle(chip)}
                              className={cn(
                                'p-0.5 rounded text-xs font-sans transition-colors cursor-pointer disabled:opacity-50',
                                chip.isSaved
                                  ? 'text-theme-primary hover:text-rose-500 hover:bg-rose-500/10'
                                  : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface'
                              )}
                              title={
                                chip.isSaved
                                  ? m.shelf_saved_remove()
                                  : (chip.shelfFeeEstimate ?? 0) > 0
                                    ? m.shelf_add_with_fee({ count: chip.shelfFeeEstimate ?? 0 })
                                    : m.shelf_add_free()
                              }
                            >
                              {chip.isSaved ? (
                                <Check className="w-3 h-3 stroke-[2]" />
                              ) : (
                                <Plus className="w-3 h-3 stroke-[2]" />
                              )}
                            </button>

                            {isCustom && Boolean(chip.canManage ?? canManage) && (
                              <button
                                type="button"
                                disabled={promotingId === chip.id}
                                onClick={() => handlePromote(chip)}
                                className="p-0.5 rounded text-theme-muted hover:text-theme-primary hover:bg-theme-primary/10 transition-colors cursor-pointer disabled:opacity-50"
                                title={m.edition_promote_to_primary()}
                                aria-label={m.edition_promote_to_primary()}
                              >
                                {promotingId === chip.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Crown className="w-3 h-3" />
                                )}
                              </button>
                            )}

                            {isCustom && (
                              <button
                                type="button"
                                disabled={deletingId === chip.id}
                                onClick={() => handleDelete(chip)}
                                className="p-0.5 rounded text-theme-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer disabled:opacity-50"
                                title={m.common_delete()}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {onCreateEdition && !isWebDoc && (
                <div
                  onClick={() => {
                    onOpenChange(false);
                    onCreateEdition(repo.owner, repo.repo);
                  }}
                  className="px-3 py-2 rounded-xl border border-dashed border-theme-primary/30 hover:border-theme-primary/60 bg-theme-primary/[0.03] hover:bg-theme-primary/[0.08] transition-all cursor-pointer flex items-center justify-between gap-2 group shadow-2xs"
                >
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <span className="p-1 rounded-md bg-theme-primary/10 text-theme-primary shrink-0 group-hover:scale-110 transition-transform">
                      <Sparkles className="w-3.5 h-3.5" />
                    </span>
                    <span className="font-medium text-theme-foreground truncate">
                      {m.edition_banner_title()}
                    </span>
                    <span className="hidden sm:inline text-micro font-mono text-theme-muted shrink-0">
                      · {m.edition_banner_subtitle()}
                    </span>
                  </div>
                  <span className="text-xs font-semibold text-theme-primary group-hover:translate-x-0.5 transition-transform flex items-center gap-1 shrink-0">
                    <span>{m.edition_banner_action()}</span>
                    <ArrowRight className="w-3 h-3" />
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-2 rounded-xl bg-theme-bg/60 border border-theme-border/50 flex items-center justify-between gap-2 flex-wrap text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-micro font-semibold text-theme-foreground flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-theme-primary" />
                  <span>{effectiveEditionLabel || m.version_trial_current_badge()}</span>
                </span>
                <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-theme-surface border border-theme-border/70 text-micro text-theme-foreground/90 font-mono shadow-2xs">
                  {isWebDoc ? (
                    <Globe className="w-3 h-3 text-sky-500 shrink-0" />
                  ) : (
                    <GitBranch className="w-3 h-3 text-theme-primary/80 shrink-0" />
                  )}
                  <span className="font-semibold">
                    {isWebDoc ? m.web_doc_snapshot() : effectiveBranch}
                  </span>
                  {effectiveCommitSha && (
                    <span className="text-theme-primary font-medium">@{effectiveCommitSha.slice(0, 7)}</span>
                  )}
                  {effectiveDate && (
                    <>
                      <span className="text-theme-border/70 select-none">·</span>
                      <span className="text-theme-muted font-normal">{formatDate(effectiveDate)}</span>
                    </>
                  )}
                </div>
              </div>

              {onCreateEdition && !isWebDoc && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onCreateEdition(repo.owner, repo.repo);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-theme-primary/10 hover:bg-theme-primary/20 text-theme-primary border border-theme-primary/30 hover:border-theme-primary/50 text-xs font-semibold shadow-2xs transition-all cursor-pointer active:scale-95 shrink-0"
                  title={m.edition_chips_custom_create()}
                >
                  <Sparkles className="w-3.5 h-3.5 text-theme-primary" />
                  <span>{m.edition_chips_custom_create()}</span>
                </button>
              )}
            </div>
          )}

          {effectiveRelay && effectiveRelay.done < effectiveRelay.total && (
            <div className="p-4 rounded-xl bg-theme-bg/60 border border-theme-border/50 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Users className="w-4 h-4 text-theme-primary shrink-0" />
                    <span className="font-mono text-xs font-semibold text-theme-foreground">
                      {m.notification_type_relay_open()}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-theme-primary/[0.08] text-theme-primary border border-theme-primary/30 text-micro font-mono font-bold">
                      {m.dashboard_relay_tag({ done: effectiveRelay.done, total: effectiveRelay.total })}
                    </span>
                    {effectiveRelay.inProgress > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20 text-micro font-sans font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        {m.relay_chapters_in_progress({ count: effectiveRelay.inProgress })}
                      </span>
                    )}
                  </div>
                  <p className="text-micro text-theme-muted font-sans">
                    {m.relay_claim_desc()}
                  </p>
                </div>

                {effectiveRelay.done < effectiveRelay.total && onOpenRelayWorkbench && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenRelayWorkbench(effectiveRelayRepo);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-theme-primary text-theme-primary-fg text-xs font-sans font-bold hover:brightness-110 active:scale-95 transition-all shadow-2xs cursor-pointer shrink-0"
                  >
                    <span>{m.dashboard_join_relay()}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="space-y-2 pt-2 border-t border-theme-border/40">
                <div className="flex items-center justify-between text-micro font-mono text-theme-muted">
                  <span>
                    {m.relay_book_progress({ done: effectiveRelay.done, total: effectiveRelay.total })}
                    {effectiveRelay.total > 0 && ` (${formatProgressPercent(effectiveRelay.done, effectiveRelay.total)}%)`}
                  </span>
                  {effectiveRelay.participants && effectiveRelay.participants.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span>{m.relay_participants_count({ count: effectiveRelay.participants.length })}</span>
                      <RelayAvatarStack participants={effectiveRelay.participants} size="xs" />
                    </div>
                  )}
                </div>

                <div className="h-2 w-full rounded-full bg-theme-surface border border-theme-border/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-theme-primary/80 transition-all"
                    style={{
                      width: `${formatProgressPercent(effectiveRelay.done, effectiveRelay.total)}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {localizedDescription ? (
            <div className="space-y-1.5">
              <p className="text-xs font-mono text-theme-muted uppercase tracking-wider">{m.tutorial_detail_intro()}</p>
              <p className="text-sm sm:text-base text-theme-foreground/90 leading-relaxed font-sans">
                {localizedDescription}
              </p>
            </div>
          ) : null}
        </DialogPanel>

        {showInsufficientGuidance && (
          <div className="px-6 py-3 border-t border-theme-border/50 bg-theme-bg/30">
            {isRelayInProgress ? (
              <div className="p-4 rounded-2xl bg-theme-primary/[0.04] border border-theme-primary/30 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-md bg-theme-primary/10 text-theme-primary border border-theme-primary/20">
                      <Sparkles className="w-3.5 h-3.5" />
                    </span>
                    <span className="font-semibold text-xs text-theme-foreground">{m.shelf_relay_exemption_title()}</span>
                    {gap > 0 && (
                      <span className="text-micro font-mono text-amber-500 font-medium">
                        {m.shelf_balance_gap({ count: gap })}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowInsufficientGuidance(false)}
                    className="p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-xs text-theme-muted leading-relaxed">
                  {m.shelf_relay_exemption_desc()}
                </p>
                <div className="pt-2 border-t border-theme-border/40 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-micro text-theme-muted font-mono">
                    {m.shelf_confirm_relay_progress({
                      done: effectiveRelay?.done ?? selectedChip?.processedDocsCount ?? repo.processedDocsCount ?? 0,
                      total: effectiveRelay?.total ?? selectedChip?.chapterCount ?? repo.chapterCount ?? 0,
                      percent: Math.round(
                        ((effectiveRelay?.done ?? selectedChip?.processedDocsCount ?? 0) /
                          Math.max(1, effectiveRelay?.total ?? selectedChip?.chapterCount ?? 1)) *
                          100
                      ),
                    })}
                  </p>
                  {onOpenRelayWorkbench && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenRelayWorkbench(effectiveRelayRepo);
                      }}
                      className="px-3.5 py-1.5 rounded-lg bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg font-sans font-bold text-xs transition-all cursor-pointer shadow-2xs flex items-center gap-1.5"
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>{m.shelf_relay_action_btn()}</span>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-2xl bg-amber-500/[0.04] border border-amber-500/30 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      <Zap className="w-3.5 h-3.5" />
                    </span>
                    <span className="font-semibold text-xs text-theme-foreground">{m.shelf_complete_earn_title()}</span>
                    {gap > 0 && (
                      <span className="text-micro font-mono text-amber-500 font-medium">
                        {m.shelf_balance_gap({ count: gap })}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowInsufficientGuidance(false)}
                    className="p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-xs text-theme-muted leading-relaxed">
                  {m.shelf_complete_earn_desc()}
                </p>

                {trendingRecommendations.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-micro font-mono text-theme-muted flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-amber-500" />
                      <span>{m.shelf_trending_recommendations_title()}</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {trendingRecommendations.slice(0, 3).map((t) => (
                        <button
                          key={`${t.owner}/${t.repo}`}
                          type="button"
                          onClick={() => {
                            onOpenChange(false);
                            onStartImport?.(`https://github.com/${t.owner}/${t.repo}`);
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-theme-surface hover:bg-theme-bg border border-theme-border/70 hover:border-amber-500/50 text-xs font-mono text-theme-foreground flex items-center gap-1.5 transition-all cursor-pointer group"
                        >
                          <Sparkles className="w-3 h-3 text-amber-500 shrink-0" />
                          <span className="font-semibold truncate max-w-[140px]">{t.owner}/{t.repo}</span>
                          <span className="text-micro text-theme-muted font-normal">★ {formatCompactNumber(t.stars)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-theme-border/40 flex items-center justify-between gap-3 flex-wrap">
                  {onSelectTab && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onSelectTab('review');
                      }}
                      className="text-micro font-medium text-theme-primary hover:underline cursor-pointer"
                    >
                      {m.shelf_action_relay_square()} →
                    </button>
                  )}
                  {onStartImport && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onStartImport();
                      }}
                      className="ml-auto px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-sans font-bold text-xs transition-all cursor-pointer shadow-2xs flex items-center gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{m.shelf_action_import_new()}</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="p-4 sm:px-7 border-t border-theme-border/60 bg-theme-bg/40 flex items-center justify-between sm:justify-between gap-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 sm:px-5 sm:py-2.5 rounded-xl border border-theme-border text-xs sm:text-sm font-sans text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
          >
            {m.common_close()}
          </button>

          <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap">
            {onToggleFavorite && (
              <button
                type="button"
                onClick={() => onToggleFavorite(repo)}
                title={
                  repo.isFavorited ? m.dashboard_unfavorite_action() : m.dashboard_favorite_action()
                }
                className={`px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-xl border font-sans font-medium text-xs sm:text-sm transition-all cursor-pointer flex items-center gap-1.5 ${
                  repo.isFavorited
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-500 hover:bg-amber-500/15'
                    : 'border-theme-border text-theme-muted hover:text-theme-foreground hover:bg-theme-surface'
                }`}
              >
                <Star
                  className={`w-3.5 h-3.5 shrink-0 ${
                    repo.isFavorited ? 'text-amber-500 fill-amber-500/20' : 'text-theme-muted/60'
                  }`}
                />
                <span>{repo.isFavorited ? m.dashboard_favorited() : m.dashboard_favorite()}</span>
              </button>
            )}

            {!repo.isSaved && onToggleSave && (
              <span className="hidden sm:inline-block text-micro font-mono text-theme-muted mr-1 select-none">
                {fee > 0 ? m.shelf_fee_hint_consume({ count: fee }) : m.shelf_fee_free_badge()}
              </span>
            )}

            {repo.isSaved ? (
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-sans font-bold text-xs sm:text-sm flex items-center gap-1.5 cursor-not-allowed opacity-90 select-none"
              >
                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>{m.shelf_in_personal_project()}</span>
              </button>
            ) : onToggleSave ? (
              <button
                type="button"
                disabled={isSaving}
                title={fee > 0 ? m.shelf_confirm_fee_required({ count: fee }) : undefined}
                onClick={async () => {
                  if (isSaving || saveLockRef.current) return;
                  if (fee > 0) {
                    if (!hasEnoughBalance) {
                      setShowInsufficientGuidance((prev) => !prev);
                      return;
                    }
                    setShowConfirmJoin(true);
                    return;
                  }
                  await handleToggleSaveClick();
                }}
                className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl border border-theme-primary/40 bg-theme-primary/10 hover:bg-theme-primary/20 text-theme-primary font-sans font-bold text-xs sm:text-sm transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSaving ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 stroke-[2.5]" />}
                <span>{m.shelf_join_free()}</span>
              </button>
            ) : null}

            <Link
              href={effectiveDocUrl}
              onClick={() => onOpenChange(false)}
              className="px-6 py-2 sm:py-2.5 rounded-xl bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg font-sans font-bold text-xs sm:text-sm transition-all cursor-pointer shadow-md flex items-center gap-2 group"
            >
              <BookOpen className="w-4 h-4" />
              <span>
                {effectiveProgress > 0 ? m.dashboard_continue() : m.dashboard_read_doc()}
                {selectedChip && effectiveEditions && effectiveEditions.length > 1 && effectiveEditionLabel ? ` (${effectiveEditionLabel})` : ''}
              </span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>

    <ConfirmDialog
      open={showConfirmJoin}
      onOpenChange={setShowConfirmJoin}
      title={m.shelf_confirm_dialog_title()}
      description={`${m.shelf_confirm_fee_required({ count: fee })}。${m.shelf_confirm_free_read_hint()}`}
      confirmText={m.shelf_confirm_btn_confirm()}
      cancelText={m.shelf_confirm_btn_cancel()}
      variant="primary"
      onConfirm={async () => {
        await handleToggleSaveClick();
      }}
    />
  </>
  );
}
