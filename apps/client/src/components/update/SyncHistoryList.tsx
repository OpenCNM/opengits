'use client';
import * as m from '@/paraglide/messages';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SyncRunItem {
  id: string;
  fromSha: string;
  toSha: string;
  finishedAt: string | Date | null;
  createdAt: string | Date;
  user: { name: string | null; email: string | null } | null;
  stats: { auto?: boolean; droppedRemoves?: number } | null;
  plan: { chapters?: Array<{ path: string; action: string; reason?: string }>; summary?: string } | null;
}

const getActionLabel = (action: string) => {
  switch (action) {
    case 'update':
      return { label: m.sync_action_update(), cls: 'bg-theme-primary/10 text-theme-primary border-theme-primary/30' };
    case 'add':
      return { label: m.sync_action_add(), cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' };
    case 'remove':
      return { label: m.common_delete(), cls: 'bg-rose-500/10 text-rose-600 border-rose-500/30' };
    default:
      return { label: m.sync_action_keep(), cls: 'bg-theme-bg text-theme-muted border-theme-border' };
  }
};

export function SyncHistoryList({ runs }: { runs: SyncRunItem[] }) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  if (runs.length === 0) return null;

  const openRun = runs.find((r) => r.id === openRunId) ?? null;

  return (
    <div className="mt-6 text-micro text-theme-muted">
      <div className="font-serif font-bold text-theme-foreground/80 mb-1.5">{m.sync_history_title()}</div>
      <ul className="space-y-0.5 font-mono">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => setOpenRunId(run.id)}
              className="w-full flex items-center gap-2 text-left hover:text-theme-foreground transition-colors cursor-pointer"
              title={m.sync_view_details()}
            >
              <span>{new Date(run.finishedAt || run.createdAt).toLocaleDateString('zh-CN')}</span>
              <span className="text-theme-foreground/70">{run.user?.name || run.user?.email || m.sync_community_member()}</span>
              <span>{m.sync_to_version({ version: (run.toSha || '').slice(0, 7) || m.sync_new_version() })}</span>
              {run.stats?.auto && (
                <span className="inline-flex items-center gap-0.5 px-1 py-px rounded border border-theme-primary/30 bg-theme-primary/10 text-theme-primary text-micro font-bold">
                  <Bot className="w-2 h-2" />{m.sync_system_auto()}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={openRunId !== null} onOpenChange={(next) => { if (next !== true) setOpenRunId(null); }}>
        <DialogContent className="max-w-lg bg-theme-bg border border-theme-border rounded-2xl p-0 overflow-hidden shadow-xl">
          <DialogHeader className="px-5 py-3.5 border-b border-theme-border/60 bg-theme-surface/50">
            <DialogTitle className="text-sm font-serif font-bold text-theme-foreground">
              {m.sync_details_version({ version: (openRun?.toSha || '').slice(0, 7) || m.sync_new_version() })}
              {openRun?.stats?.auto && (
                <span className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-px rounded border border-theme-primary/30 bg-theme-primary/10 text-theme-primary text-micro font-bold align-middle">
                  <Bot className="w-2.5 h-2.5" />{m.sync_system_auto()}</span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="p-4 max-h-[50vh] overflow-y-auto space-y-1.5">
            {(openRun?.plan?.chapters ?? []).map((ch, i) => {
              const meta = getActionLabel(ch.action);
              return (
                <div key={`${ch.path}-${i}`} className="flex items-start gap-2 text-xs font-mono">
                  <span className={cn('px-1.5 py-px rounded border text-micro font-bold shrink-0', meta.cls)}>
                    {meta.label}
                  </span>
                  <span className="text-theme-foreground/80 break-all">{ch.path}</span>
                  {ch.reason && <span className="text-theme-muted text-micro break-all ml-auto max-w-[45%] text-right">{ch.reason}</span>}
                </div>
              );
            })}
            {openRun?.plan?.summary && (
              <p className="pt-2 text-micro text-theme-muted leading-relaxed border-t border-theme-border/40">
                {openRun.plan.summary}
              </p>
            )}
            {openRun?.stats?.droppedRemoves ? (
              <p className="text-micro text-amber-600 leading-relaxed">
                {m.sync_dropped_removes_notice({ count: openRun.stats.droppedRemoves })}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
