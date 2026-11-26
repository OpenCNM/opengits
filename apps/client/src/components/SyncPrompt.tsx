"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { runIngestion } from '@/app/actions/sync';
import { useRouter } from 'next/navigation';
import { ignoreBestEffort } from '@/lib/best-effort';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Database, RefreshCw, AlertCircle, ArrowLeft } from 'lucide-react';
import * as m from '@/paraglide/messages';

const SYNC_POLL_INTERVAL_MS = 2500;
const SYNC_POLL_MAX_MS = 10 * 60 * 1000;

async function pollJobTerminal(jobId: string): Promise<'COMPLETED' | 'FAILED' | 'TIMEOUT'> {
  const deadline = Date.now() + SYNC_POLL_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`/api/ingest-jobs/${jobId}`, { cache: 'no-store' });
      if (res.ok) {
        const snapshot = (await res.json()) as { job?: { status?: string } };
        const status = snapshot.job?.status;
        if (status === 'COMPLETED') return 'COMPLETED';
        if (status === 'FAILED') return 'FAILED';
      }
    } catch {
      ignoreBestEffort();
    }
    await new Promise((r) => setTimeout(r, SYNC_POLL_INTERVAL_MS));
  }
  return 'TIMEOUT';
}

export default function SyncPrompt({
  owner,
  repo,
  canSync = true,
}: {
  owner: string;
  repo: string;
  canSync?: boolean;
}) {
 const [isSyncing, setIsSyncing] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const router = useRouter();
 const abortRef = useRef(false);

 useEffect(() => {
  return () => {
  abortRef.current = true;
  };
 }, []);

 const handleSync = useCallback(async () => {
 setIsSyncing(true);
 setError(null);
 abortRef.current = false;

 const result = await runIngestion(owner, repo);

 if (!result.success) {
 setError(result.error || 'Unknown error occurred during sync.');
 setIsSyncing(false);
 return;
 }

 const terminal = result.jobId ? await pollJobTerminal(result.jobId) : 'TIMEOUT';
 if (abortRef.current) return;

 if (terminal === 'COMPLETED' || terminal === 'TIMEOUT') {
 router.refresh();
 } else {
 setError(m.sync_prompt_failed());
 }
 setIsSyncing(false);
 }, [owner, repo, router]);

 return (
 <div className="flex flex-col items-center justify-center max-w-xl mx-auto text-center px-6 py-12">
  <div className="relative mb-8">
   <div className="w-24 h-24 bg-theme-bg border border-theme-border shadow-[inset_0_0_20px_rgba(0,0,0,0.02)] rounded-sm flex items-center justify-center relative">
    <Database size={40} className="text-theme-muted" />
    <div className="absolute -bottom-2 -right-2 w-8 h-8 bg-theme-bg rounded-sm flex items-center justify-center border border-theme-border shadow-xs">
     <RefreshCw size={14} className={`text-theme-foreground ${isSyncing ? 'animate-spin' : ''}`} />
    </div>
   </div>
  </div>

  <h1 className="text-2xl md:text-[1.75rem] font-medium text-theme-foreground mb-4 tracking-wide" style={{ fontFamily: 'var(--font-serif)' }}>
   {canSync ? m.sync_prompt_title() : m.sync_prompt_guest_title()}
  </h1>

  <p className="text-sm md:text-base text-theme-muted leading-relaxed max-w-md mb-8">
   {canSync ? m.sync_prompt_desc() : m.sync_prompt_guest_desc()}
  </p>

  {error && (
   <Alert variant="error" className="theme-primary !bg-transparent mb-8 border border-theme-accent/30 text-left rounded-sm shadow-xs p-4">
    <div className="flex items-start gap-3">
     <AlertCircle className="h-5 w-5 text-theme-accent mt-0.5" />
     <div>
      <AlertTitle className="text-sm font-semibold text-theme-accent mb-1">{m.toast_action_failed()}</AlertTitle>
      <AlertDescription className="text-xs text-theme-accent font-mono">{error}</AlertDescription>
     </div>
    </div>
   </Alert>
  )}

  <div className="flex flex-wrap items-center justify-center gap-3">
   {canSync && (
    <Button
     onClick={handleSync}
     loading={isSyncing}
     size="lg"
     className="px-6 py-3 flex items-center gap-2 bg-theme-foreground hover:bg-theme-foreground/90 text-theme-bg rounded-sm shadow-xs active:scale-95 transition-all duration-300 text-sm font-medium border border-theme-border cursor-pointer"
    >
     {!isSyncing && <RefreshCw size={16} />}
     {isSyncing ? m.common_loading() : m.sync_prompt_btn()}
    </Button>
   )}
   <Link
    href="/"
    className="px-6 py-2.5 inline-flex items-center gap-2 rounded-sm border border-theme-border bg-theme-bg text-theme-foreground hover:bg-theme-surface transition-all text-sm font-medium shadow-2xs hover:border-theme-border/80"
   >
    <ArrowLeft size={16} className="text-theme-muted" />
    {m.account_back_to_bookshelf()}
   </Link>
  </div>
 </div>
 );
}
