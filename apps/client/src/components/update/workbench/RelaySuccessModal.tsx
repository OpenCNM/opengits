'use client';

import React from 'react';
import Link from 'next/link';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  ExternalLink,
  Sparkles,
  Trophy,
  X,
  ArrowRight,
} from 'lucide-react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import * as m from '@/paraglide/messages';
import { docPathToSlug } from './relay-recommendation';
import type { RelaySuccessResult } from './useUpdateWorkbench';

export interface RelaySuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: RelaySuccessResult | null;
  onContinueNext?: () => void;
}

export function RelaySuccessModal({
  isOpen,
  onClose,
  result,
  onContinueNext,
}: RelaySuccessModalProps) {
  if (!result) return null;

  const cleanSlug = docPathToSlug(result.path);
  const readUrl = `/docs/${result.owner}/${result.repo}/${cleanSlug}`;

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      showHeader={false}
      bodyClassName="p-0 overflow-hidden select-none bg-theme-bg"
    >
      <div className="relative p-6 bg-gradient-to-b from-theme-primary/10 via-theme-surface/60 to-theme-surface/30 border-b border-theme-border/60 text-center space-y-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={m.common_close()}
          className="absolute top-4 right-4 w-7 h-7 rounded-lg flex items-center justify-center text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/80 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="mx-auto w-12 h-12 rounded-2xl bg-theme-primary/15 border border-theme-primary/30 flex items-center justify-center text-theme-primary shadow-sm">
          <Sparkles className="w-6 h-6 animate-pulse" />
        </div>

        <div className="space-y-1">
          <h3 className="text-lg font-serif font-bold text-theme-foreground">
            {m.relay_success_title()}
          </h3>
          <p className="text-xs text-theme-muted max-w-xs mx-auto">
            {m.relay_success_desc()}
          </p>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <div className="rounded-xl border border-theme-border/70 bg-theme-surface/40 p-3.5 space-y-1">
          {result.chapterTitle && (
            <p className="text-micro font-serif font-medium text-theme-muted">
              {result.chapterTitle}
            </p>
          )}
          <h4 className="text-sm font-serif font-bold text-theme-foreground">
            {result.title}
          </h4>
          <p className="text-micro font-mono text-theme-muted/60 truncate">
            {result.path}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-micro text-theme-muted">
              <Clock className="w-3.5 h-3.5 text-blue-500" />
              <span>{m.relay_metric_duration()}</span>
            </div>
            <p className="text-sm font-mono font-bold text-theme-foreground">
              {m.relay_metric_duration_val({ seconds: result.durationSeconds })}
            </p>
          </div>

          <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-micro text-theme-muted">
              <Coins className="w-3.5 h-3.5 text-amber-500" />
              <span>{m.relay_metric_tokens()}</span>
            </div>
            <p className="text-sm font-mono font-bold text-theme-foreground">
              {result.tokensUsed.toLocaleString()}
            </p>
          </div>

          <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-micro text-theme-muted">
              <Cpu className="w-3.5 h-3.5 text-purple-500" />
              <span>{m.relay_metric_model()}</span>
            </div>
            <p className="text-xs font-mono font-semibold text-theme-foreground truncate" title={result.model}>
              {result.model}
            </p>
          </div>

          <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-micro text-theme-muted">
              <Trophy className="w-3.5 h-3.5 text-emerald-500" />
              <span>{m.relay_metric_honor()}</span>
            </div>
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {m.relay_metric_honor_val()}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5 text-micro">
            <p className="font-bold text-theme-foreground">
              {m.relay_synced_bookshelf_title()}
            </p>
            <p className="text-theme-muted leading-relaxed">
              {m.relay_synced_bookshelf_desc()}
            </p>
          </div>
        </div>

        <div className="pt-1 flex flex-col sm:flex-row gap-2">
          <Link
            href={readUrl}
            target="_blank"
            onClick={onClose}
            className="flex-1 py-2.5 px-4 rounded-xl bg-theme-primary text-theme-primary-fg hover:opacity-90 active:scale-[0.99] text-xs font-bold shadow-sm flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          >
            <BookOpen className="w-4 h-4" />
            <span>{m.relay_action_read_now()}</span>
            <ExternalLink className="w-3 h-3 opacity-70" />
          </Link>

          <button
            type="button"
            onClick={() => {
              onClose();
              onContinueNext?.();
            }}
            className="flex-1 py-2.5 px-4 rounded-xl bg-theme-surface hover:bg-theme-border/40 text-theme-foreground border border-theme-border text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5"
          >
            <span>{m.relay_action_continue_next()}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </AnimatedModal>
  );
}
