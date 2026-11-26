import * as m from '@/paraglide/messages';
import React, { useRef, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Terminal, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress';
import {
  resolveRepoIngestProgress,
  type RepoIngestStageKey,
} from '@/lib/import-wizard/repo-ingest-progress';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';

function resolveRepoStageMessage(stageKey: RepoIngestStageKey): string {
  switch (stageKey) {
    case 'init':
      return m.repo_ingest_stage_init();
    case 'sha':
      return m.repo_ingest_stage_sha();
    case 'archive':
      return m.repo_ingest_stage_archive();
    case 'scan':
      return m.repo_ingest_stage_scan();
    case 'outline':
      return m.repo_ingest_stage_outline();
    case 'persist':
      return m.repo_ingest_stage_persist();
    case 'done':
      return m.repo_ingest_stage_done();
  }
}

interface IngestLogLinesProps {
  logs: string[];
  logsEndRef: React.RefObject<HTMLDivElement | null>;
}

function IngestLogLines({ logs, logsEndRef }: IngestLogLinesProps) {
  if (logs.length === 0) {
    return <div className="text-theme-muted italic text-micro">{m.import_step3_preparing()}</div>;
  }
  return (
    <>
      {logs.map((log, i) => (
        <div key={i} className="flex items-start gap-2 break-all">
          <span className="text-theme-muted/60 text-micro shrink-0">
            {new Date().toISOString().substring(11, 19)}
          </span>
          <span
            className={
              log.includes('[ERROR]')
                ? 'text-rose-600 font-semibold'
                : log.includes('✓') || log.includes('successfully')
                  ? 'text-emerald-600 font-medium'
                  : 'text-theme-foreground'
            }
          >
            {log}
          </span>
        </div>
      ))}
      <div ref={logsEndRef} />
    </>
  );
}

interface CollapsibleLogsDrawerProps {
  logs: string[];
  latestLog: string;
  isExpanded: boolean;
  onToggle: () => void;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
}

function CollapsibleLogsDrawer({
  logs,
  latestLog,
  isExpanded,
  onToggle,
  logsEndRef,
}: CollapsibleLogsDrawerProps) {
  return (
    <div className="rounded-xl border border-theme-border/60 bg-theme-bg overflow-hidden shrink-0 transition-all duration-200 shadow-2xs text-left w-full">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3.5 py-2 bg-theme-surface/40 flex items-center justify-between text-xs cursor-pointer select-none hover:bg-theme-surface/80 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Terminal size={12} className="text-theme-muted shrink-0" />
          <span className="text-micro font-serif font-bold text-theme-foreground shrink-0">
            {m.import_step3_logs_title()}
          </span>
          <span className="text-theme-border select-none">·</span>
          <span className="text-micro font-mono text-theme-muted truncate flex-1">
            {latestLog || m.import_step3_preparing()}
          </span>
        </div>

        <div className="flex items-center gap-2 text-micro font-mono text-theme-muted shrink-0 ml-3">
          <span className="px-1.5 py-0.2 rounded bg-theme-bg border border-theme-border/60">
            {logs.length}
          </span>
          <span className="text-theme-muted hover:text-theme-foreground flex items-center gap-1 font-serif text-micro">
            {isExpanded ? m.import_step3_toggle_logs_collapse() : m.import_step3_toggle_logs_expand()}
            {isExpanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="p-3 max-h-48 overflow-y-auto space-y-1.5 font-mono text-micro leading-relaxed text-theme-foreground custom-scrollbar bg-theme-bg border-t border-theme-border/40 animate-in fade-in duration-200">
          <IngestLogLines logs={logs} logsEndRef={logsEndRef} />
        </div>
      )}
    </div>
  );
}

interface WorkbenchStep3ExecutingProps {
  onGoToTutorial: () => void;
  onGoToShelf: () => void;
}

export function WorkbenchStep3Executing({ onGoToTutorial, onGoToShelf }: WorkbenchStep3ExecutingProps) {
  const ingestSuccessInfo = useImportWizardStore((s) => s.ingestSuccessInfo);
  const ingestFailed = useImportWizardStore((s) => s.ingestFailed);
  const logs = useImportWizardStore((s) => s.logs);
  const importMode = useImportWizardStore((s) => s.importMode);
  const customOutline = (useImportWizardStore((s) => s.customOutline) || []) as WorkbenchOutlineCategory[];

  const [isLogsExpanded, setIsLogsExpanded] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const outlineSummaryRef = useRef<{ chapters: number; lessons: number } | null>(null);
  if (outlineSummaryRef.current === null && customOutline.length > 0) {
    outlineSummaryRef.current = {
      chapters: customOutline.length,
      lessons: customOutline.reduce((acc, cat) => acc + (cat.files?.length || 0), 0),
    };
  }

  const chaptersCount = outlineSummaryRef.current?.chapters ?? customOutline.length;
  const lessonsCount =
    outlineSummaryRef.current?.lessons ??
    customOutline.reduce((acc, cat) => acc + (cat.files?.length || 0), 0);

  useEffect(() => {
    if (isLogsExpanded) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isLogsExpanded]);

  const latestLog = logs && logs.length > 0 ? logs[logs.length - 1] : '';

  const repoProgress = resolveRepoIngestProgress(logs, Boolean(ingestSuccessInfo));
  const stageMessage = resolveRepoStageMessage(repoProgress.stageKey);

  if (ingestSuccessInfo) {
    if (importMode === 'web') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center py-8 px-4 md:px-8 text-center space-y-6 max-w-lg mx-auto w-full animate-in fade-in duration-300">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shadow-xs">
            <CheckCircle2 size={28} />
          </div>

          <div className="space-y-2">
            <h3 className="text-base md:text-lg font-bold font-serif text-theme-foreground tracking-tight">
              {m.import_ingest_web_success_title()}
            </h3>
            <p className="text-xs md:text-sm text-theme-muted leading-relaxed">
              {m.import_ingest_web_success_desc()}
            </p>
          </div>

          <div className="w-full max-w-sm pt-1">
            <button
              type="button"
              onClick={onGoToTutorial}
              className="w-full h-12 md:h-13 px-8 bg-theme-primary hover:opacity-95 text-theme-primary-fg font-serif font-bold text-sm md:text-base tracking-wide rounded-2xl transition-all shadow-md active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2.5 group"
            >
              <span>{m.import_step3_web_enter_reading()}</span>
              <ArrowRight size={18} className="transition-transform group-hover:translate-x-1 shrink-0" />
            </button>
          </div>

          {logs.length > 0 && (
            <div className="w-full pt-2">
              <CollapsibleLogsDrawer
                logs={logs}
                latestLog={latestLog}
                isExpanded={isLogsExpanded}
                onToggle={() => setIsLogsExpanded((prev) => !prev)}
                logsEndRef={logsEndRef}
              />
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center py-8 px-4 md:px-8 text-center space-y-6 max-w-xl mx-auto w-full animate-in fade-in duration-300">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shadow-xs">
          <CheckCircle2 size={28} />
        </div>

        <h3 className="text-base md:text-lg font-bold font-serif text-theme-foreground tracking-tight">
          {m.import_ingest_success_title()}
        </h3>

        <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 rounded-2xl bg-theme-surface/50 border border-theme-border/70 text-left font-sans select-none shadow-xs">
          <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-theme-bg/80 border border-theme-border/60">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-micro text-theme-muted font-mono font-bold">01</span>
                <span className="text-micro font-mono text-emerald-500 font-semibold bg-emerald-500/10 px-1.5 py-0.2 rounded">
                  {m.import_step3_stage_done()}
                </span>
              </div>
              <span className="font-bold text-xs text-theme-foreground truncate block mt-0.5">
                {m.import_step3_stage_code()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-theme-bg/80 border border-theme-border/60">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-micro text-theme-muted font-mono font-bold">02</span>
                <span className="text-micro font-mono text-emerald-500 font-semibold bg-emerald-500/10 px-1.5 py-0.2 rounded">
                  {m.import_step3_stage_done()}
                </span>
              </div>
              <span className="font-bold text-xs text-theme-foreground truncate block mt-0.5">
                {m.import_step3_stage_outline()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-theme-primary/10 border border-theme-primary/30">
            <Loader2 size={16} className="animate-spin text-theme-primary shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-micro text-theme-primary font-mono font-bold">03</span>
                <span className="text-micro font-mono text-theme-primary font-semibold bg-theme-primary/15 px-1.5 py-0.2 rounded">
                  {m.import_step3_stage_in_progress()}
                </span>
              </div>
              <span className="font-bold text-xs text-theme-foreground truncate block mt-0.5">
                {m.import_step3_stage_transcribing()}
              </span>
            </div>
          </div>
        </div>

        <div className="w-full max-w-sm pt-2">
          <button
            type="button"
            onClick={onGoToTutorial}
            className="w-full h-12 md:h-13 px-8 bg-theme-primary hover:opacity-95 text-theme-primary-fg font-serif font-bold text-sm md:text-base tracking-wide rounded-2xl transition-all shadow-md active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2.5 group"
          >
            <span>{m.import_step3_enter_detail()}</span>
            <ArrowRight size={18} className="transition-transform group-hover:translate-x-1 shrink-0" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-3.5">
      {!ingestFailed && (
        <div className="p-3.5 rounded-xl border border-theme-border/70 bg-theme-surface/40 flex items-center justify-between gap-3 shrink-0 shadow-2xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-theme-primary/10 text-theme-primary flex items-center justify-center shrink-0">
              <Loader2 size={16} className="animate-spin text-theme-primary" />
            </div>
            <div className="min-w-0">
              <h4 className="text-xs font-serif font-bold text-theme-foreground truncate">
                {importMode === 'web' ? m.import_step3_web_building_title() : m.import_step3_building_title()}
              </h4>
              <p className="text-micro text-theme-muted mt-0.5 truncate">
                {importMode === 'web' ? m.import_step3_web_building_desc() : stageMessage}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {chaptersCount > 0 ? (
              <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-micro font-mono bg-theme-bg border border-theme-border/60 text-theme-muted shrink-0">
                {m.import_step3_total_summary({ chapters: chaptersCount, lessons: lessonsCount })}
              </span>
            ) : null}
            {importMode !== 'web' && (
              <span className="px-2 py-0.5 rounded-full text-micro font-mono font-bold bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shrink-0">
                {repoProgress.percent}%
              </span>
            )}
          </div>
        </div>
      )}

      {importMode !== 'web' && !ingestFailed ? (
        <div className="flex-1 min-h-[300px] flex flex-col justify-between p-6 rounded-2xl border border-theme-border/70 bg-theme-surface/30 shadow-2xs space-y-6">
          <div className="flex-1 flex flex-col items-center justify-center max-w-lg mx-auto w-full space-y-5 text-center">
            <div className="w-full space-y-2.5">
              <div className="flex items-center justify-between text-micro font-mono text-theme-muted px-0.5">
                <span className="flex items-center gap-2 font-medium text-theme-foreground text-xs font-serif">
                  <Loader2 size={14} className="animate-spin text-theme-primary shrink-0" />
                  <span>{stageMessage}</span>
                </span>
                <span className="font-bold text-theme-primary">{repoProgress.percent}%</span>
              </div>
              <Progress value={repoProgress.percent} aria-label={stageMessage}>
                <ProgressTrack className="h-2.5 w-full rounded-full bg-theme-border/60 overflow-hidden">
                  <ProgressIndicator className="h-full rounded-full bg-theme-primary transition-all duration-500 ease-out" />
                </ProgressTrack>
              </Progress>
            </div>

            <div className="flex flex-col items-center gap-1.5">
              {repoProgress.downloadMeta ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-micro font-mono bg-theme-bg border border-theme-border/60 text-theme-muted shadow-2xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <span>{repoProgress.downloadMeta}</span>
                </span>
              ) : null}
              <p className="text-micro text-theme-muted max-w-md leading-relaxed">
                {m.repo_ingest_progress_caption()}
              </p>
            </div>
          </div>

          <CollapsibleLogsDrawer
            logs={logs}
            latestLog={latestLog}
            isExpanded={isLogsExpanded}
            onToggle={() => setIsLogsExpanded((prev) => !prev)}
            logsEndRef={logsEndRef}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-theme-border bg-theme-bg shadow-xs overflow-hidden flex flex-col flex-1 min-h-[280px] font-sans text-xs">
          <div className="px-3 py-2 bg-theme-surface/50 border-b border-theme-border flex items-center justify-between gap-3 select-none">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-xs font-serif font-bold text-theme-foreground shrink-0">
                {m.import_step3_logs_title()}
              </span>
              <span className="text-theme-border select-none">·</span>
              <span className="text-micro font-mono text-theme-muted truncate flex-1">
                {latestLog || m.import_step3_preparing()}
              </span>
            </div>
            <span className="text-micro font-mono text-theme-muted shrink-0">{logs.length}</span>
          </div>
          <div className="p-3 flex-1 overflow-y-auto space-y-1.5 font-mono text-micro leading-relaxed text-theme-foreground custom-scrollbar bg-theme-bg">
            <IngestLogLines logs={logs} logsEndRef={logsEndRef} />
          </div>
        </div>
      )}

      {ingestSuccessInfo && (
        <div className="p-3.5 rounded-xl border border-theme-border/80 bg-theme-surface/70 backdrop-blur-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 shadow-xs animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center gap-2 text-xs text-theme-muted min-w-0">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="font-serif truncate">
              {m.import_step3_safe_close_hint()}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0 sm:ml-auto w-full sm:w-auto">
            <button
              type="button"
              onClick={onGoToTutorial}
              className="w-full sm:w-auto h-11 md:h-12 px-7 md:px-9 bg-theme-primary hover:opacity-95 text-theme-primary-fg font-serif font-bold text-sm tracking-wide rounded-xl transition-all shadow-md active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2.5 group"
            >
              <span>{m.import_step3_enter_detail()}</span>
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-1 shrink-0" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
