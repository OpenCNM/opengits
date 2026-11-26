'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { BookOpen, Globe, ArrowRight, Plus } from 'lucide-react';
import { DisplayRepo } from '@/lib/home-data';
import { isNativeWebDocMirror } from '@/lib/repository-origin';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { formatRelativeTime } from '@/lib/format';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import * as m from '@/paraglide/messages';

interface DashboardResumeCardProps {
  recentResumeRepo: DisplayRepo | null;
  onToggleSave?: (repo: DisplayRepo) => Promise<void> | void;
}

export function DashboardResumeCard({ recentResumeRepo, onToggleSave }: DashboardResumeCardProps) {
  const [isJoining, setIsJoining] = useState(false);
  const joinLockRef = React.useRef(false);

  const handleScrollToFeed = () => {
    const feedElem = document.getElementById('feed-section');
    if (feedElem) {
      feedElem.scrollIntoView({ behavior: 'smooth' });
    }
  };

  if (!recentResumeRepo) {
    return (
      <div className="lg:col-span-5 xl:col-span-4 space-y-3.5 lg:border-l lg:border-theme-border/50 lg:pl-6">
        <div className="shrink-0 flex items-center justify-between pb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-theme-muted flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5 text-theme-foreground/70" />
            {m.dashboard_learning_overview()}
          </span>
          <span className="text-micro font-mono text-theme-muted/50">{m.dashboard_zero_projects()}</span>
        </div>
        <button
          type="button"
          onClick={handleScrollToFeed}
          className="w-full h-9 px-3.5 border border-dashed border-theme-border/80 hover:border-theme-foreground/30 hover:bg-theme-surface/50 rounded-lg flex items-center justify-between transition-all group cursor-pointer text-left"
        >
          <span className="text-xs text-theme-muted truncate flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-theme-muted/40 group-hover:bg-emerald-500 transition-colors shrink-0" />
            <span className="truncate">{m.dashboard_empty_shelf_hint()}</span>
          </span>
          <span className="text-xs font-medium text-theme-foreground shrink-0 group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5 ml-2">
            <span>{m.dashboard_explore_square()}</span>
            <ArrowRight className="w-3 h-3 text-theme-muted group-hover:text-theme-foreground transition-colors" />
          </span>
        </button>
      </div>
    );
  }

  const docSlug = recentResumeRepo.lastReadPath ? recentResumeRepo.lastReadPath.replace(/\.mdx?$/, '') : '';
  const editionParam = recentResumeRepo.edition ? `?edition=${encodeURIComponent(recentResumeRepo.edition)}` : '';
  const docUrl = `/docs/${recentResumeRepo.owner}/${recentResumeRepo.repo}${docSlug ? '/' + docSlug : ''}${editionParam}`;
  const chapterTitle = recentResumeRepo.lastReadPath
    ? recentResumeRepo.lastReadPath.replace(/\.mdx?$/, '').replace(/^.*[\\\/]/, '')
    : null;
  const hideReadingProgress = isNativeWebDocMirror(recentResumeRepo);

  const relativeTimeStr = formatRelativeTime(recentResumeRepo.lastReadAt || recentResumeRepo.updatedAt);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const repoKey = recentResumeRepo?.owner && recentResumeRepo?.repo
    ? recentResumeRepo.edition
      ? `${recentResumeRepo.owner}/${recentResumeRepo.repo}:${recentResumeRepo.edition}`
      : `${recentResumeRepo.owner}/${recentResumeRepo.repo}`
    : undefined;

  const clientScores = useReadingProgressStore((s) => s.chapterScores);

  const { liveChapterScore, liveProgressVal } = useMemo(() => {
    const fallbackProgress = Math.min(100, Math.max(0, recentResumeRepo?.progress || 0));
    if (!recentResumeRepo || !mounted) {
      return { liveChapterScore: 0, liveProgressVal: fallbackProgress };
    }

    const docPath = recentResumeRepo.lastReadPath || '';
    const chapterScore = docPath
      ? useReadingProgressStore.getState().getChapterScore(docPath, repoKey)
      : 0;

    let computedOverall = fallbackProgress;
    if (repoKey && recentResumeRepo.chapterCount > 0) {
      const prefix = `${repoKey.toLowerCase()}:`;
      const repoScores = Object.entries(clientScores)
        .filter(([k]) => k.toLowerCase().startsWith(prefix))
        .map(([, v]) => v);

      if (repoScores.length > 0) {
        const sum = repoScores.reduce((a, b) => a + b, 0);
        const optimisticOverall = Math.round(sum / recentResumeRepo.chapterCount);
        computedOverall = Math.max(computedOverall, optimisticOverall);
      }
    }

    return {
      liveChapterScore: chapterScore,
      liveProgressVal: Math.min(100, Math.max(0, computedOverall)),
    };
  }, [recentResumeRepo, mounted, repoKey, clientScores]);

  return (
    <div className="lg:col-span-5 xl:col-span-4 space-y-3.5 lg:border-l lg:border-theme-border/50 lg:pl-6">
      <div className="shrink-0 flex items-center justify-between pb-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-theme-muted flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5 text-theme-foreground/70" />
          {m.dashboard_last_read()}
        </span>
        {!hideReadingProgress && (
          <div
            className="flex items-center gap-2 px-2 py-0.5 rounded-full bg-theme-surface border border-theme-border/80"
            role="progressbar"
            aria-valuenow={liveProgressVal}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="w-10 h-1.5 rounded-full bg-theme-foreground/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-theme-primary transition-all duration-500"
                style={{ width: `${liveProgressVal}%` }}
              />
            </div>
            <span className="text-xs font-mono font-bold text-theme-foreground tabular-nums leading-none">
              {liveProgressVal}%
            </span>
          </div>
        )}
      </div>

      <div className="h-9 flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="font-mono text-xs text-theme-foreground truncate font-semibold flex items-center gap-1.5">
            {isWebDocRepository(recentResumeRepo) ? (
              <>
                <Globe className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                <strong className="font-bold truncate">{resolveRepositoryDisplayName(recentResumeRepo)}</strong>
              </>
            ) : (
              <>
                <GithubIcon className="w-3.5 h-3.5 text-theme-foreground/80 shrink-0" />
                <span className="truncate">
                  {recentResumeRepo.owner}/<strong className="font-semibold">{recentResumeRepo.repo}</strong>
                </span>
              </>
            )}
            {!recentResumeRepo.isSaved && (
              <span className="inline-flex items-center px-1.5 py-0.2 rounded text-micro font-sans font-medium text-theme-muted bg-theme-surface border border-theme-border/60 shrink-0">
                {m.dashboard_public_tutorials()}
              </span>
            )}
          </div>

          <div className="text-micro font-sans text-theme-muted truncate flex items-center gap-2">
            {chapterTitle && (
              <span className="truncate">
                <span className="text-theme-muted/70">{m.dashboard_chapter()}: </span>
                <span className="font-mono text-theme-foreground/80">{chapterTitle}</span>
                {!hideReadingProgress && liveChapterScore > 0 && (
                  <span className="ml-1 text-micro font-mono text-theme-primary font-medium">({liveChapterScore}%)</span>
                )}
              </span>
            )}
            {chapterTitle && relativeTimeStr && (
              <span className="text-theme-muted/40">•</span>
            )}
            {relativeTimeStr && (
              <span className="shrink-0 text-theme-muted/70">{relativeTimeStr}</span>
            )}
            {!recentResumeRepo.isSaved && onToggleSave && (
              <>
                <span className="text-theme-muted/40">•</span>
                <button
                  type="button"
                  disabled={isJoining}
                  onClick={async () => {
                    if (isJoining || joinLockRef.current) return;
                    joinLockRef.current = true;
                    setIsJoining(true);
                    try {
                      await onToggleSave(recentResumeRepo);
                    } finally {
                      joinLockRef.current = false;
                      setIsJoining(false);
                    }
                  }}
                  className="inline-flex items-center gap-0.5 text-theme-primary hover:underline cursor-pointer font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-2.5 h-2.5" />
                  <span>{m.dashboard_join_project()}</span>
                </button>
              </>
            )}
          </div>
        </div>

        <Link
          href={docUrl}
          className="h-9 px-3.5 bg-theme-primary text-theme-primary-fg hover:opacity-90 active:scale-[0.98] font-medium text-xs font-sans rounded-lg shrink-0 cursor-pointer transition-all shadow-none flex items-center justify-center gap-1 group"
        >
          <span>{m.dashboard_continue()}</span>
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>
    </div>
  );
}
