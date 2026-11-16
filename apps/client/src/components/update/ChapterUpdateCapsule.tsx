'use client';

import React, { useEffect, useState } from 'react';
import { ArrowUpCircle, Clock, GitCompare, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import type { ChapterUpdateJobStatus } from '@/lib/state/status-vocabularies';
import { UpdateWorkbenchModal } from './UpdateWorkbenchModal';

export interface ActiveUpdateJob {
  id: string;
  /** 7 态词汇（SSOT 见 lib/state/status-vocabularies；活跃窗口只出现 PENDING/CLAIMED/TRIAL） */
  status: ChapterUpdateJobStatus;
  frozenCredits: number;
  voteDeadline: string | Date | null;
  claimedBy: string | null;
}

export interface ChapterUpdateCapsuleProps {
  owner: string;
  repo: string;
  job: ActiveUpdateJob;
  isLoggedIn: boolean;
  className?: string;
}

function useCountdown(deadline: string | Date | null | undefined): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!deadline) {
      setText(null);
      return;
    }
    const compute = () => {
      const ms = new Date(deadline).getTime() - Date.now();
      if (ms <= 0) return null;
      const hours = Math.floor(ms / 3600_000);
      const minutes = Math.floor((ms % 3600_000) / 60_000);
      return hours > 0 ? m.time_hours_minutes({ hours, minutes }) : m.time_minutes({ minutes });
    };
    setText(compute());
    const timer = setInterval(() => setText(compute()), 60_000);
    return () => clearInterval(timer);
  }, [deadline]);
  return text;
}

export function ChapterUpdateCapsule({ owner, repo, job, isLoggedIn, className }: ChapterUpdateCapsuleProps) {
  const [openModal, setOpenModal] = useState(false);
  const countdown = useCountdown(job.voteDeadline);

  const isTrial = job.status === 'TRIAL';
  const isPending = job.status === 'PENDING';

  return (
    <>
      <div className={cn('inline-flex items-center my-2', className)}>
        {isPending && (
          <button
            type="button"
            onClick={() => setOpenModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-theme-primary/35 bg-theme-primary/[0.08] text-theme-primary text-xs font-medium hover:bg-theme-primary/15 transition-all cursor-pointer shadow-2xs group"
          >
            <Sparkles className="w-3.5 h-3.5 text-theme-primary group-hover:scale-110 transition-transform shrink-0" />
            <span>{m.chapter_update_available()}</span>
            <span className="text-micro font-mono px-1.5 py-0.2 rounded-full bg-theme-primary/15 border border-theme-primary/30">
              {m.common_details()}
            </span>
          </button>
        )}

        {isTrial && (
          <button
            type="button"
            onClick={() => setOpenModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-theme-primary/40 bg-theme-primary/[0.08] text-theme-primary text-xs font-medium hover:bg-theme-primary/15 transition-all cursor-pointer shadow-2xs group"
          >
            <Sparkles className="w-3.5 h-3.5 text-theme-primary group-hover:scale-110 transition-transform shrink-0" />
            <span>{m.chapter_update_available()}</span>
            <span className="text-micro font-mono px-1.5 py-0.2 rounded-full bg-theme-primary/15 border border-theme-primary/30">
              {m.common_details()}
            </span>
          </button>
        )}

        {job.status === 'CLAIMED' && (
          <button
            type="button"
            onClick={() => setOpenModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-theme-border bg-theme-surface/70 text-theme-muted text-xs font-medium hover:text-theme-foreground hover:border-theme-border transition-all cursor-pointer shadow-2xs"
          >
            <Users className="w-3.5 h-3.5 text-theme-primary shrink-0" />
            <span>{m.chapter_update_community_transcribing()}</span>
            <span className="text-micro font-mono opacity-80">{m.chapter_update_click_progress()}</span>
          </button>
        )}
      </div>

      <UpdateWorkbenchModal
        open={openModal}
        onOpenChange={setOpenModal}
        owner={owner}
        repo={repo}
        initialJobId={job.id}
        isLoggedIn={isLoggedIn}
      />
    </>
  );
}
