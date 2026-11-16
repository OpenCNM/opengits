'use client';

import * as m from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime.js';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useUsageStats } from '@/hooks/use-usage-stats';
import {
  Zap,
  BookOpen,
  Sparkles,
  Loader2,
  AlertCircle,
  Brain,
  MessageSquare,
  FileText,
  Layers,
  ListFilter,
  Layers3,
  Rocket,
  HardDrive,
  Terminal,
  ArrowUpRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import {
  formatTokenCount,
  getPhaseTitle,
  getPhaseDesc,
  type UsageSummary,
} from './utils/tokenFormatters';
import { useUserQuotaSummary } from './hooks/useUserQuotaSummary';

/** 个人配额与用量概览（数据源 /api/usage/summary，实时呈现个人用量统计） */
function QuotaOverview({ summary }: { summary: UsageSummary | null }) {
  if (!summary) {
    return (
      <div className="flex h-24 items-center justify-center text-theme-muted text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> {m.usage_quota_loading()}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-theme-border bg-theme-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-theme-primary/40 bg-theme-primary/10 px-3 py-1 text-xs font-bold text-theme-primary">
            <Sparkles className="h-3 w-3" />
            {summary.isAdmin ? 'Admin' : m.usage_stats_overview()}
          </span>
          {m.usage_stats_refresh_hint() ? (
            <span className="text-xs text-theme-muted">
              {m.usage_stats_refresh_hint()}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-theme-muted"><HardDrive className="h-4 w-4" /> {m.usage_bookshelf_repos()}</span>
            <span className="font-mono font-bold">{summary.reposUsed} {m.unit_repos()}</span>
          </div>
          {/* maxRepos=0 表示不限量：不渲染假比例进度条 */}
          {summary.maxRepos > 0 && (
            <Progress value={Math.min(100, Math.round((summary.reposUsed / summary.maxRepos) * 100))} />
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-theme-muted"><Terminal className="h-4 w-4" /> {m.usage_today_mcp_calls()}</span>
            <span className="font-mono font-bold">
              {summary.mcpCallsToday} {m.unit_times()}
              {summary.dailyMcpCalls > 0 && (
                <span className="text-theme-muted font-normal"> / {summary.dailyMcpCalls}</span>
              )}
            </span>
          </div>
          {summary.dailyMcpCalls > 0 && (
            <Progress value={Math.min(100, Math.round((summary.mcpCallsToday / summary.dailyMcpCalls) * 100))} />
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-theme-muted"><Zap className="h-4 w-4" /> {m.usage_30d_tokens()}</span>
            <span className="font-mono font-bold">{formatTokenCount(summary.tokens30d)}</span>
          </div>
          {/* 30 天 token 无配额上限：仅展示绝对值，无进度条 */}
        </div>
      </div>
    </div>
  );
}

export function UsageStatisticsView() {
  const [activeTab, setActiveTab] = useState<'app' | 'mcp'>('app');
  const [dimensionMode, setDimensionMode] = useState<'phase' | 'scenario'>('phase');
  const { timeRange, setTimeRange, data, isLoading, error, refresh } = useUsageStats('30d');
  const { quota } = useUserQuotaSummary();

  if (isLoading && !data) {
    return (
      <div className="flex h-96 w-full items-center justify-center text-theme-muted">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        <span>{m.usage_loading()}</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-3 text-red-500">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm font-medium">{m.usage_fetch_failed()}</p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {m.common_retry()}
        </Button>
      </div>
    );
  }

  const summary = data?.summary || {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    tutorialCount: 0,
    importTokens: 0,
    importPercentage: 0,
    transcriptionTokens: 0,
    transcriptionPercentage: 0,
    chatTokens: 0,
    chatPercentage: 0,
    indexingTokens: 0,
    indexingPercentage: 0,
  };

  const phaseBreakdown = data?.phaseBreakdown || [];
  const scenarioBreakdown = data?.scenarioBreakdown || [];

  return (
    <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as 'app' | 'mcp')} className="w-full space-y-6 text-theme-foreground">
      {/* 配额与用量概览 */}
      <QuotaOverview summary={quota} />

      {/* Header & Tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-theme-border pb-4">
        <TabsList variant="underline">
          <TabsTrigger value="app" className="text-sm font-bold">{m.usage_tab_token()}</TabsTrigger>
          <TabsTrigger value="mcp" className="text-sm font-bold">{m.usage_tab_mcp()}</TabsTrigger>
        </TabsList>

        {/* Time Range Filter */}
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="text-theme-muted mr-1">{m.usage_time_range()}</span>
          <div className="inline-flex rounded-lg p-1 bg-theme-surface border border-theme-border">
            <button
              onClick={() => setTimeRange('7d')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                timeRange === '7d'
                  ? 'bg-theme-bg text-theme-foreground shadow-sm font-bold'
                  : 'text-theme-muted hover:text-theme-foreground'
              }`}
            >
              {m.usage_last_7_days()}
            </button>
            <button
              onClick={() => setTimeRange('30d')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                timeRange === '30d'
                  ? 'bg-theme-bg text-theme-foreground shadow-sm font-bold'
                  : 'text-theme-muted hover:text-theme-foreground'
              }`}
            >
              {m.usage_last_30_days()}
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'mcp' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5">
              <div className="flex items-center justify-between text-xs font-medium">
                <div className="flex items-center gap-2 text-theme-muted">
                  <Terminal className="h-4 w-4 text-theme-primary" />
                  <span>{m.usage_today_mcp_calls()}</span>
                </div>
                <Link
                  href="/analytics/queries"
                  className="inline-flex items-center gap-0.5 text-xs text-theme-primary hover:underline font-normal"
                >
                  <span>{m.usage_mcp_details_link()}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
              <div className="mt-3 font-mono text-2xl font-bold">
                {quota?.mcpCallsToday ?? '—'}
                {quota?.dailyMcpCalls && quota.dailyMcpCalls > 0 ? (
                  <span className="text-xs text-theme-muted font-normal ml-1.5">/ {quota.dailyMcpCalls} {m.unit_times()}</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5">
              <div className="flex items-center gap-2 text-theme-muted text-xs font-medium">
                <HardDrive className="h-4 w-4 text-theme-primary" />
                <span>{m.usage_bookshelf_repos()}</span>
              </div>
              <div className="mt-3 font-mono text-2xl font-bold">
                {quota?.reposUsed ?? '—'}
                {quota?.maxRepos && quota.maxRepos > 0 ? (
                  <span className="text-xs text-theme-muted font-normal ml-1.5">/ {quota.maxRepos} {m.unit_repos()}</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5">
              <div className="flex items-center justify-between text-xs font-medium">
                <div className="flex items-center gap-2 text-theme-muted">
                  <Rocket className="h-4 w-4 text-theme-primary" />
                  <span>{m.usage_mcp_access_method()}</span>
                </div>
                <Link
                  href="/settings/mcp-tokens"
                  className="inline-flex items-center gap-0.5 text-xs text-theme-primary hover:underline font-normal"
                >
                  <span>{m.mcp_manage_tokens()}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
              <div className="mt-3 text-sm font-bold">Bearer API Token</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Top 4 Focus KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Total Token Consumption */}
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5 shadow-xs transition-all hover:border-theme-border/80">
              <div className="flex items-center justify-between text-theme-foreground text-sm font-semibold">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-theme-primary" />
                  <span>{m.usage_total_tokens_consumed()}</span>
                </div>
              </div>
              <div className="mt-3">
                <div className="text-3xl font-extrabold tracking-tight font-mono">
                  {formatTokenCount(summary.totalTokens)}
                </div>
                <div className="mt-2 text-xs text-theme-muted flex flex-wrap items-center gap-x-2 gap-y-1 font-mono">
                  <span>{m.usage_input_label({ tokens: formatTokenCount(summary.promptTokens) })}</span>
                  <span>•</span>
                  <span>{m.usage_output_label({ tokens: formatTokenCount(summary.completionTokens) })}</span>
                </div>
              </div>
            </div>

            {/* Card 2: Tutorial Count */}
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5 shadow-xs transition-all hover:border-theme-border/80">
              <div className="flex items-center gap-2 text-theme-foreground text-sm font-semibold">
                <BookOpen className="h-4 w-4 text-theme-primary" />
                <span>{m.usage_card_covered_tutorials()}</span>
              </div>
              <div className="mt-3">
                <div className="text-3xl font-extrabold tracking-tight font-mono">
                  {summary.tutorialCount} <span className="text-sm font-normal text-theme-muted font-sans">{m.unit_books()}</span>
                </div>
                <div className="mt-2 text-xs text-theme-muted leading-relaxed">
                  {m.usage_card_covered_desc()}
                </div>
              </div>
            </div>

            {/* Card 3: Import & Scout Phase Tokens */}
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5 shadow-xs transition-all hover:border-theme-border/80">
              <div className="flex items-center gap-2 text-theme-foreground text-sm font-semibold">
                <FileText className="h-4 w-4 text-theme-primary" />
                <span>{m.usage_card_scout_tokens()}</span>
              </div>
              <div className="mt-3">
                <div className="text-3xl font-extrabold tracking-tight font-mono">
                  {formatTokenCount(summary.importTokens)}
                </div>
                <div className="mt-2 text-xs text-theme-muted leading-relaxed">
                  {m.usage_card_scout_desc({ pct: summary.importPercentage })}
                </div>
              </div>
            </div>

            {/* Card 4: Transcription & Course Generation Tokens */}
            <div className="flex flex-col justify-between rounded-xl border border-theme-border bg-theme-card p-5 shadow-xs transition-all hover:border-theme-border/80">
              <div className="flex items-center gap-2 text-theme-foreground text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-theme-primary" />
                <span>{m.usage_card_transcription_tokens()}</span>
              </div>
              <div className="mt-3">
                <div className="text-3xl font-extrabold tracking-tight font-mono">
                  {formatTokenCount(summary.transcriptionTokens)}
                </div>
                <div className="mt-2 text-xs text-theme-muted leading-relaxed">
                  {m.usage_card_scout_desc({ pct: summary.transcriptionPercentage })}
                </div>
              </div>
            </div>
          </div>

          {/* Section: Token Consumption by Phase & Scenario (With View Filter) */}
          <div className="rounded-xl border border-theme-border bg-theme-card p-5 shadow-xs space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Brain className="h-4 w-4 text-theme-primary" />
                <span>{m.usage_distribution_title()}</span>
              </h3>

              {/* View Switcher */}
              <div className="flex items-center gap-1 text-xs text-theme-muted">
                <span className="mr-1">{m.usage_stat_dimension()}</span>
                <div className="inline-flex rounded-lg p-0.5 bg-theme-surface border border-theme-border">
                  <button
                    onClick={() => setDimensionMode('phase')}
                    className={`rounded-md px-2.5 py-1 text-xs transition-all flex items-center gap-1 ${
                      dimensionMode === 'phase'
                        ? 'bg-theme-bg text-theme-foreground font-bold shadow-xs'
                        : 'text-theme-muted hover:text-theme-foreground'
                    }`}
                  >
                    <Layers3 className="h-3 w-3" />
                    <span>{m.usage_by_phase()}</span>
                  </button>
                  <button
                    onClick={() => setDimensionMode('scenario')}
                    className={`rounded-md px-2.5 py-1 text-xs transition-all flex items-center gap-1 ${
                      dimensionMode === 'scenario'
                        ? 'bg-theme-bg text-theme-foreground font-bold shadow-xs'
                        : 'text-theme-muted hover:text-theme-foreground'
                    }`}
                  >
                    <ListFilter className="h-3 w-3" />
                    <span>{m.usage_by_scenario()}</span>
                  </button>
                </div>
              </div>
            </div>

            {dimensionMode === 'phase' ? (
              /* Phase Breakdown View */
              phaseBreakdown.length === 0 ? (
                <div className="text-xs text-theme-muted py-6 text-center">{m.usage_no_phase_data()}</div>
              ) : (
                <div className="space-y-4">
                  {phaseBreakdown.map((p) => (
                    <div key={p.phaseKey} className="space-y-1.5 border-b border-theme-border/40 pb-3.5 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between text-xs sm:text-sm">
                        <div className="flex items-center gap-2">
                          <Layers className="h-4 w-4 text-theme-primary" />
                          <span className="font-semibold text-theme-foreground">{getPhaseTitle(p.phaseKey, p.label)}</span>
                          <span className="text-theme-muted text-xs font-mono">{m.usage_calls_count({ count: p.callCount })}</span>
                        </div>
                        <div className="flex items-center gap-3 sm:gap-4 text-theme-muted text-xs sm:text-sm font-mono">
                          <span>{m.usage_input_label({ tokens: formatTokenCount(p.promptTokens) })}</span>
                          <span>{m.usage_output_label({ tokens: formatTokenCount(p.completionTokens) })}</span>
                          <span>{m.usage_total_tokens_label()} <strong className="text-theme-foreground font-bold">{formatTokenCount(p.totalTokens)}</strong></span>
                          <span className="font-bold text-theme-primary">{p.percentage}%</span>
                        </div>
                      </div>
                      <p className="text-xs text-theme-muted leading-relaxed font-sans">{getPhaseDesc(p.phaseKey, p.description)}</p>
                      {/* Coss UI Progress Bar */}
                      <Progress value={p.percentage} className="h-2 w-full mt-1" />
                    </div>
                  ))}
                </div>
              )
            ) : (
              /* Scenario Breakdown View */
              scenarioBreakdown.length === 0 ? (
                <div className="text-xs text-theme-muted py-6 text-center">{m.usage_no_scenario_data()}</div>
              ) : (
                <div className="space-y-4">
                  {scenarioBreakdown.map((s) => (
                    <div key={s.source} className="space-y-1.5 border-b border-theme-border/40 pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between text-xs sm:text-sm">
                        <div className="flex items-center gap-2">
                          <MessageSquare className="h-4 w-4 text-theme-muted" />
                          <span className="font-semibold text-theme-foreground">{s.label}</span>
                          <span className="text-theme-muted text-xs font-mono">{m.usage_calls_count({ count: s.callCount })}</span>
                        </div>
                        <div className="flex items-center gap-3 sm:gap-4 text-theme-muted text-xs sm:text-sm font-mono">
                          <span>{m.usage_input_label({ tokens: formatTokenCount(s.promptTokens) })}</span>
                          <span>{m.usage_output_label({ tokens: formatTokenCount(s.completionTokens) })}</span>
                          <span>{m.usage_total_tokens_label()} <strong className="text-theme-foreground font-bold">{formatTokenCount(s.totalTokens)}</strong></span>
                          <span className="font-bold text-theme-primary">{s.percentage}%</span>
                        </div>
                      </div>
                      {/* Coss UI Progress Bar */}
                      <Progress value={s.percentage} className="h-2 w-full mt-1" />
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}
    </Tabs>
  );
}
