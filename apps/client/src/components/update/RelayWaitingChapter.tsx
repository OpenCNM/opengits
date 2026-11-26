'use client';
import * as m from '@/paraglide/messages';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { BookOpen, Clock, Loader2, Sparkles, Users } from 'lucide-react';
import { toastManager } from '@/components/ui/toast';
import { RelayAvatarStack } from '@/components/update/RelayAvatarStack';
import { RelaySuccessModal } from '@/components/update/workbench/RelaySuccessModal';
import type { RelaySuccessResult } from '@/components/update/workbench/useUpdateWorkbench';
import { requireApiKey } from '@/lib/api-key-guard';
import { api } from '@/lib/api/client';
import { useDocumentStore } from '@/lib/stores/document-store';
import { useRelayTaskStore } from '@/lib/stores/relay-task-store';
import type { RelayParticipant } from '@/components/update/RelayAvatarStack';

export interface RelayWaitingChapterProps {
  documentId?: string;
  docTitle: string | null;
  docPath: string;
  claimableJobId: string | null;
  estimatedCredits: number;
  progress: { done: number; total: number; inProgress: number };
  participants: RelayParticipant[];
}

export function RelayWaitingChapter({
  documentId,
  docTitle,
  docPath,
  claimableJobId,
  estimatedCredits,
  progress,
  participants,
}: RelayWaitingChapterProps) {
  const currentDocId = documentId || docPath;
  useEffect(() => {
    useDocumentStore.getState().setDocumentContext({
      documentId: currentDocId,
      repositoryId: null,
      isTranscribed: false,
    });
    return () => {
      useDocumentStore.getState().clearDocumentContext(currentDocId);
    };
  }, [currentDocId]);

  const router = useRouter();
  const params = useParams();
  const owner = (params?.owner as string) || '';
  const repo = (params?.repo as string) || '';
  const activeTask = useRelayTaskStore((s) => s.activeTask);

  const [claiming, setClaiming] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [successResult, setSuccessResult] = useState<RelaySuccessResult | null>(null);

  useEffect(() => {
    if (!claiming) {
      setElapsedSeconds(0);
      return;
    }
    const compute = () => {
      if (activeTask?.startedAt) {
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activeTask.startedAt) / 1000)));
      } else {
        setElapsedSeconds((s) => s + 1);
      }
    };
    compute();
    const timer = setInterval(compute, 1000);
    return () => clearInterval(timer);
  }, [claiming, activeTask?.startedAt]);

  const progressPercent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  const claimThisChapter = () => {
    requireApiKey(async () => {
      const targetId = claimableJobId || documentId;
      if (!targetId) return;
      setClaiming(true);
      useRelayTaskStore.getState().startTask({
        owner,
        repo,
        nodeId: targetId,
        path: docPath,
        title: docTitle || docPath,
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
          nodeId: targetId,
          path: res.path || docPath,
          title: res.title || docTitle || docPath,
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
        router.refresh();
      } catch (err) {
        useRelayTaskStore.getState().failTask(err instanceof Error ? err.message : '');
        toastManager.add({
          type: 'warning',
          title: m.toast_action_failed(),
          description: err instanceof Error ? err.message : '',
        });
      } finally {
        setClaiming(false);
      }
    }, m.apikey_continue_transcribe());
  };

  return (
    <div className="my-6 flex flex-col items-center gap-5 rounded-2xl border border-theme-border/70 bg-theme-surface/50 p-8 text-center font-sans shadow-2xs">
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-theme-primary/30 bg-theme-primary/[0.08] text-theme-primary text-xs font-bold">
        <Clock className="w-3.5 h-3.5" />
        {m.relay_waiting_community()}
      </span>

      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-bold text-theme-foreground">
          {docTitle || docPath}
        </h2>
        <p className="font-mono text-micro text-theme-muted">{docPath}</p>
      </div>

      <div className="w-full max-w-sm flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-theme-muted">
          <span className="inline-flex items-center gap-1">
            <BookOpen className="w-3 h-3" />
            {m.relay_book_progress({ done: progress.done, total: progress.total })}
          </span>
          {progress.inProgress > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3 h-3" />
              {m.relay_chapters_in_progress({ count: progress.inProgress })}
              <span className="inline-block w-1 h-1 rounded-full bg-theme-primary animate-pulse" />
            </span>
          )}
        </div>
        <div className="h-1.5 w-full rounded-full bg-theme-border/60 overflow-hidden">
          <div className="h-full rounded-full bg-theme-primary/70" style={{ width: `${progressPercent}%` }} />
        </div>
        {participants.length > 0 && (
          <div className="flex justify-center pt-1">
            <RelayAvatarStack participants={participants} size="xs" />
          </div>
        )}
      </div>

      <p className="text-xs leading-relaxed text-theme-muted max-w-sm">
        {m.relay_claim_desc()}
      </p>

      <button
        type="button"
        onClick={claimThisChapter}
        disabled={claiming}
        className="inline-flex items-center gap-2 rounded-xl bg-theme-primary px-5 py-2.5 text-theme-primary-fg text-xs font-bold shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer disabled:opacity-50"
      >
        {claiming ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="font-mono">{m.relay_waiting_transcribing({ seconds: elapsedSeconds })}</span>
          </>
        ) : (
          <>
            <Sparkles className="w-3.5 h-3.5" />
            <span>{m.relay_claim()}</span>
          </>
        )}
      </button>

      <RelaySuccessModal
        isOpen={successResult !== null}
        onClose={() => {
          setSuccessResult(null);
          useRelayTaskStore.getState().dismissTask();
        }}
        result={successResult}
        onContinueNext={() => {
          setSuccessResult(null);
          useRelayTaskStore.getState().dismissTask();
        }}
      />
    </div>
  );
}
