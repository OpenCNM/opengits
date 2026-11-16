'use client';
import * as m from '@/paraglide/messages';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Globe2,
  Loader2,
  Rocket,
  RotateCw,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { ENGINE_CONFIG } from '@/lib/config';
import type { ModuleTab } from '@/lib/schemas/webdoc-topology';
import {
  buildScopePayload,
  chipModules,
  defaultSelectedPaths,
  isDefaultSelectedModule,
} from '@/lib/import-wizard/webdoc-scope';
import { formatWebDocTargetDisplay } from '@/lib/import-wizard/navigation';
import {
  useImportWizardStore,
  wizardFlow,
  type WebDocScoutSnapshot,
} from '@/lib/stores/import-wizard-store';
import { useImportWizard } from '../ImportWizardContext';

/**
 * WebDoc 专属确认步骤（第 2 步「嗅探站点」→ 第 3 步「确认目录」）：
 * 彻底剥离 GitHub 仓专属杂项（公共教程开关/积分说明/双 Tab 切换条/重复标题壳），
 * 提交时静默沿用后端默认值 `isPublic: true`（0 积分且可秒级复用公共文档库）。
 */
export type ScoutState =
  | { status: 'loading' }
  | { status: 'scan_failed'; reason?: string }
  | {
      status: 'ready';
      scoutStatus: 'multi_module' | 'single_module';
      primaryDocPrefix: string;
      moduleTabs: ModuleTab[];
      /** 侧栏章节名预览（展示型，静态单页快照，切目录勾选不变） */
      sidebarHeadings: string[];
    };

export interface WebDocScopeStepProps {
  /** 测试注入用初始状态覆盖；生产调用不传 */
  initialScoutOverride?: ScoutState;
}

const CLIENT_SCOUT_TIMEOUT_MS = 26_000;
const MIN_SCOUT_LOADING_MS = 450;

function resolveScanFailedCopy(reason?: string): string {
  const lower = (reason || '').toLowerCase();
  if (lower.includes('429')) {
    return m.webdoc_scout_rate_limited();
  }
  if (lower.includes('sidecar') || lower.includes('fetch failed') || lower.includes('econnrefused')) {
    return m.webdoc_scout_service_unavailable();
  }
  return m.webdoc_scout_scan_failed();
}

export interface WebDocScoutRequestParams {
  url: string;
  bypassCache: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onState: (state: ScoutState) => void;
}

/**
 * 发起一次网页文档拓扑探测，返回 cleanup 函数。
 * 区分 cleanup 取消（StrictMode 双发 / 切 URL / 重试 / 卸载）与真实超时：
 * - cleanup 调用的 abort 必须静默退出，绝不能覆盖下一轮探测的 loading 状态；
 * - 仅在未取消且真实超时或请求/探测失败时才进入 scan_failed。
 */
export function startWebDocScout({
  url,
  bypassCache,
  timeoutMs = CLIENT_SCOUT_TIMEOUT_MS,
  fetchImpl = fetch,
  onState,
}: WebDocScoutRequestParams): () => void {
  let cancelled = false;
  let timedOut = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  onState({ status: 'loading' });

  (async () => {
    try {
      const res = await fetchImpl('/api/ingest/web-doc/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, bypassCache }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (cancelled) return;
      const data = json?.data;
      if (!data?.available || data?.scoutStatus === 'scan_failed') {
        throw new Error(data?.reason ?? 'scan_failed');
      }
      const tabs: ModuleTab[] = Array.isArray(data.moduleTabs) ? data.moduleTabs : [];
      const primary =
        typeof data.primaryDocPrefix === 'string' && data.primaryDocPrefix ? data.primaryDocPrefix : '/';
      const headings: string[] = Array.isArray(data.sidebarHeadings)
        ? data.sidebarHeadings.filter((h: unknown): h is string => typeof h === 'string')
        : [];
      const scoutStatus: 'multi_module' | 'single_module' =
        data.scoutStatus === 'multi_module' || chipModules(tabs).length >= 2 ? 'multi_module' : 'single_module';
      onState({
        status: 'ready',
        scoutStatus,
        primaryDocPrefix: primary,
        moduleTabs: tabs,
        sidebarHeadings: headings,
      });
    } catch (err) {
      if (cancelled) return;
      if (timedOut) {
        onState({ status: 'scan_failed', reason: 'timeout' });
      } else {
        onState({
          status: 'scan_failed',
          reason: err instanceof Error ? err.message : undefined,
        });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
    controller.abort();
  };
}

function toScoutState(snapshot: WebDocScoutSnapshot | null, currentUrl: string): ScoutState {
  if (!snapshot || snapshot.url !== currentUrl.trim()) {
    return { status: 'loading' };
  }
  if (snapshot.status === 'ready') {
    return {
      status: 'ready',
      scoutStatus: snapshot.scoutStatus ?? 'single_module',
      primaryDocPrefix: snapshot.primaryDocPrefix ?? '/',
      moduleTabs: snapshot.moduleTabs ?? [],
      sidebarHeadings: snapshot.sidebarHeadings ?? [],
    };
  }
  if (snapshot.status === 'scan_failed') {
    return { status: 'scan_failed', reason: snapshot.reason };
  }
  return { status: 'loading' };
}

function samePaths(lhs: ReadonlySet<string>, rhs: readonly string[]): boolean {
  if (lhs.size !== rhs.length) return false;
  return rhs.every((path) => lhs.has(path));
}

export function WebDocScopeStep({ initialScoutOverride }: WebDocScopeStepProps = {}) {
  const { url, submitWebDocImport } = useImportWizard();
  const storedScout = useImportWizardStore((s) => s.webScoutState);
  const storedMode = useImportWizardStore((s) => s.webScopeMode);
  const storedSelected = useImportWizardStore((s) => s.webSelectedPaths);

  const [submitting, setSubmitting] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [overrideMode, setOverrideMode] = useState<'recommended' | 'all'>('recommended');
  const [overrideSelected, setOverrideSelected] = useState<Set<string>>(() =>
    initialScoutOverride?.status === 'ready'
      ? new Set(defaultSelectedPaths(initialScoutOverride.primaryDocPrefix, chipModules(initialScoutOverride.moduleTabs)))
      : new Set(),
  );

  const isOverride = Boolean(initialScoutOverride);
  const scout = useMemo(
    () => (initialScoutOverride ? initialScoutOverride : toScoutState(storedScout, url)),
    [initialScoutOverride, storedScout, url],
  );
  const mode = isOverride ? overrideMode : storedMode;
  const selected = useMemo(
    () => (isOverride ? overrideSelected : new Set(storedSelected)),
    [isOverride, overrideSelected, storedSelected],
  );

  const { hostname, endpoint: displayEndpoint } = formatWebDocTargetDisplay(url);

  useEffect(() => {
    if (initialScoutOverride) return;
    // 同 URL 已有就绪嗅探缓存且非主动重探时，直接复用 Store 快照
    if (probeNonce === 0 && storedScout && storedScout.url === url.trim() && storedScout.status === 'ready') {
      return;
    }

    let effectDisposed = false;
    let failDelayTimer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const commitState = (nextState: ScoutState) => {
      if (nextState.status === 'ready') {
        const defaults = defaultSelectedPaths(nextState.primaryDocPrefix, chipModules(nextState.moduleTabs));
        wizardFlow.applyWebScoutResult(url, nextState, defaults);
      } else {
        wizardFlow.applyWebScoutResult(url, nextState);
      }
    };

    const cleanup = startWebDocScout({
      url,
      bypassCache: probeNonce > 0,
      onState: (nextState) => {
        if (effectDisposed) return;
        // 首次进入与重试若遇到毫秒级快失败（如侧端未连接/429 限流），先保证可见嗅探 loading 再落到失败提示
        if (nextState.status === 'scan_failed') {
          const remaining = MIN_SCOUT_LOADING_MS - (Date.now() - startedAt);
          if (remaining > 0) {
            failDelayTimer = setTimeout(() => {
              if (!effectDisposed) commitState(nextState);
            }, remaining);
            return;
          }
        }
        commitState(nextState);
      },
    });

    return () => {
      effectDisposed = true;
      if (failDelayTimer) clearTimeout(failDelayTimer);
      cleanup();
    };
  }, [url, probeNonce, initialScoutOverride, storedScout?.url, storedScout?.status]);

  const chips = scout.status === 'ready' ? chipModules(scout.moduleTabs) : [];
  const isMultiModule = scout.status === 'ready' && chips.length >= 2;
  const defaultPaths =
    scout.status === 'ready' ? defaultSelectedPaths(scout.primaryDocPrefix, chips) : [];

  const setMode = (nextMode: 'recommended' | 'all') => {
    if (isOverride) {
      setOverrideMode(nextMode);
    } else {
      wizardFlow.setWebScopeMode(nextMode);
    }
  };

  const toggleDirectory = (path: string) => {
    if (isOverride) {
      setOverrideSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      return;
    }
    wizardFlow.toggleWebSelectedPath(path);
  };

  const handleSelectAllDirs = () => {
    const allPaths = chips.map((c) => c.path);
    if (isOverride) {
      setOverrideMode('recommended');
      setOverrideSelected(new Set(allPaths));
    } else {
      wizardFlow.setWebScopeMode('recommended');
      wizardFlow.setWebSelectedPaths(allPaths);
    }
  };

  const handleResetRecommendedDirs = () => {
    if (isOverride) {
      setOverrideMode('recommended');
      setOverrideSelected(new Set(defaultPaths));
    } else {
      wizardFlow.setWebScopeMode('recommended');
      wizardFlow.setWebSelectedPaths(defaultPaths);
    }
  };

  const handleBackToInput = () => {
    wizardFlow.goBackToInput();
  };

  const primaryModuleLabel =
    scout.status === 'ready'
      ? (scout.moduleTabs.find((t) => t.path === scout.primaryDocPrefix)?.label ?? scout.primaryDocPrefix)
      : '';

  const scope = buildScopePayload({
    mode,
    primaryDocPrefix: scout.status === 'ready' ? scout.primaryDocPrefix : '',
    selectedPaths: [...selected],
    moduleTabs: scout.status === 'ready' ? scout.moduleTabs : [],
  });

  const isScouting = scout.status === 'loading';

  const handleRetryProbe = () => {
    if (isScouting || submitting) return;
    wizardFlow.applyWebScoutResult(url, { status: 'loading' });
    setProbeNonce((n) => n + 1);
  };

  const handleSubmit = async () => {
    if (submitting || isScouting) return;
    setSubmitting(true);
    try {
      // WebDoc 统一沿用 Schema 默认公开复用策略（isPublic: true），免除冗余开关干扰
      await submitWebDocImport({
        maxPages: ENGINE_CONFIG.webCrawler.defaultMaxPages,
        isPublic: true,
        scope,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const ctaLabel = submitting
    ? m.webdoc_submitting_btn()
    : isScouting
      ? m.webdoc_cta_scouting()
      : scout.status !== 'ready'
        ? m.webdoc_start_crawl_btn()
        : mode === 'all'
          ? m.webdoc_start_crawl_entire()
          : isMultiModule && selected.size > 0
            ? m.webdoc_start_crawl_count({ count: selected.size })
            : m.webdoc_start_crawl_single();

  const singleDirLabel = scout.status === 'ready' ? (chips[0]?.label || hostname) : '';
  const matchesDefaultSelection = samePaths(selected, defaultPaths);

  return (
    <div className="w-full max-w-xl mx-auto py-2 flex flex-col gap-5 text-left font-sans animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* 极简目标站点上下文行（无大卡片与重复步骤头） */}
      <div className="flex items-center justify-between gap-3 px-1 text-caption text-theme-muted">
        <span className="font-mono truncate min-w-0" title={url}>
          {displayEndpoint}
        </span>
        <div className="flex items-center gap-3 shrink-0">
          {scout.status === 'ready' && (
            <button
              type="button"
              onClick={handleRetryProbe}
              disabled={submitting}
              className="inline-flex items-center gap-1 hover:text-theme-primary transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw size={11} />
              <span>{m.webdoc_reprobe_link()}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleBackToInput}
            className="hover:text-theme-primary transition-colors cursor-pointer whitespace-nowrap"
          >
            {m.webdoc_back_to_input()}
          </button>
        </div>
      </div>

      {/* 主体：嗅探中 | 探测失败 | 目录勾选清单 */}
      {isScouting ? (
        <div className="py-10 px-6 rounded-2xl border border-theme-border/60 bg-theme-surface/50 flex flex-col items-center justify-center text-center gap-2.5">
          <Loader2 size={22} className="animate-spin text-theme-primary" />
          <p className="text-sm font-medium text-theme-foreground">
            {m.webdoc_scouting_host({ host: hostname })}
          </p>
          <p className="text-caption text-theme-muted max-w-sm">
            {m.webdoc_scouting_detail()}
          </p>
        </div>
      ) : scout.status === 'scan_failed' ? (
        <div
          className="p-4 rounded-xl border border-theme-border/60 bg-theme-surface/60 flex items-center justify-between gap-3"
          title={scout.reason}
        >
          <span className="text-caption text-theme-muted leading-relaxed">
            {resolveScanFailedCopy(scout.reason)}
          </span>
          <button
            type="button"
            onClick={handleRetryProbe}
            disabled={submitting}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-theme-border/70 bg-theme-bg hover:border-theme-primary/50 hover:text-theme-primary text-caption text-theme-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCw size={11} />
            <span>{m.webdoc_scout_retry()}</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* 标题行 + 轻量右侧文字操作（替代双 Tab 与重复说明文字） */}
          <div className="flex items-center justify-between gap-3 px-0.5">
            <h4 className="text-xs font-semibold text-theme-foreground">
              {m.webdoc_select_dirs_title()}
            </h4>

            <div className="flex items-center gap-2.5 text-caption shrink-0">
              {mode === 'all' ? (
                <button
                  type="button"
                  onClick={() => setMode('recommended')}
                  className="text-theme-primary hover:underline cursor-pointer whitespace-nowrap"
                >
                  {m.webdoc_switch_by_dir()}
                </button>
              ) : (
                <>
                  {isMultiModule && selected.size < chips.length && (
                    <button
                      type="button"
                      onClick={handleSelectAllDirs}
                      className="text-theme-muted hover:text-theme-primary transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {m.webdoc_select_all_action()}
                    </button>
                  )}
                  {isMultiModule && !matchesDefaultSelection && (
                    <button
                      type="button"
                      onClick={handleResetRecommendedDirs}
                      className="text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {m.webdoc_reset_recommended_dirs()}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setMode('all')}
                    className="text-theme-muted hover:text-theme-primary transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {m.webdoc_switch_entire_site()}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 整站模式提示 | 多目录勾选网格 | 单目录卡片 */}
          {mode === 'all' ? (
            <div className="p-4 rounded-xl border border-theme-primary/40 bg-theme-primary/5 flex items-center gap-3">
              <Globe2 size={16} className="text-theme-primary shrink-0" />
              <p className="text-xs text-theme-foreground">
                {m.webdoc_entire_site_banner({ host: hostname })}
              </p>
            </div>
          ) : isMultiModule ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {chips.map((chip) => {
                const isChecked = selected.has(chip.path);
                const isRecommended = isDefaultSelectedModule(chip, scout.primaryDocPrefix);
                const inlineTag =
                  chip.kind === 'changelog'
                    ? m.webdoc_dir_skip_tag()
                    : isRecommended && chip.kind === 'api'
                      ? m.webdoc_dir_api_tag()
                      : isRecommended
                        ? m.webdoc_dir_default_tag()
                        : null;

                return (
                  <label
                    key={`${chip.id}:${chip.path}`}
                    className={cn(
                      'flex items-start gap-2.5 p-3 rounded-xl border text-left transition-all cursor-pointer select-none',
                      isChecked
                        ? 'border-theme-primary/55 bg-theme-surface shadow-2xs'
                        : 'border-theme-border/60 bg-theme-bg/50 text-theme-muted hover:border-theme-border hover:bg-theme-surface/60',
                    )}
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleDirectory(chip.path)}
                      className="mt-0.5 border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            'text-xs truncate',
                            isChecked ? 'font-semibold text-theme-foreground' : 'font-medium text-theme-muted',
                          )}
                        >
                          {chip.label}
                        </span>
                        {inlineTag && (
                          <span
                            className={cn(
                              'text-micro shrink-0 whitespace-nowrap',
                              isRecommended ? 'text-theme-primary' : 'text-theme-muted/80',
                            )}
                          >
                            {inlineTag}
                          </span>
                        )}
                      </div>
                      <p className="text-micro font-mono text-theme-muted truncate">{chip.path}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="flex items-start gap-2.5 p-3 rounded-xl border border-theme-primary/55 bg-theme-surface shadow-2xs select-none">
              <Checkbox
                checked={true}
                disabled
                className="mt-0.5 border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-theme-foreground truncate">
                    {singleDirLabel}
                  </span>
                  <span className="text-micro text-theme-primary shrink-0 whitespace-nowrap">
                    {m.webdoc_dir_default_tag()}
                  </span>
                </div>
                <p className="text-micro font-mono text-theme-muted truncate">{scout.primaryDocPrefix}</p>
              </div>
            </div>
          )}

          {/* 章节预览（仅在按目录模式且存在探测章节时轻量展示一行） */}
          {mode !== 'all' && scout.sidebarHeadings.length > 0 && (
            <p
              className="text-caption text-theme-muted truncate px-0.5"
              title={scout.sidebarHeadings.join(' · ')}
            >
              <Check size={11} className="inline-block align-[-1px] text-theme-primary mr-1" />
              {m.webdoc_chapters_preview({ module: primaryModuleLabel })}
              <span className="ml-1">{scout.sidebarHeadings.join(' · ')}</span>
            </p>
          )}
        </div>
      )}

      {/* 唯一主行动按钮 */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || isScouting}
        className="w-full flex items-center justify-center gap-2 py-2.5 bg-theme-primary text-theme-primary-fg rounded-xl font-bold text-xs hover:opacity-90 transition-opacity cursor-pointer shadow-xs disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {submitting || isScouting ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Rocket size={14} />
        )}
        <span>{ctaLabel}</span>
      </button>
    </div>
  );
}
