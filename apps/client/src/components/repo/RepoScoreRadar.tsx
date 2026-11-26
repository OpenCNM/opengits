'use client';

import React, { useState } from 'react';
import { Compass, RotateCw, History, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import {
  AXES_ORDER,
  getAxisConfig,
  compassPoints,
  type RadarAxis,
} from './utils/radarGeometry';
import {
  useRadarProfile,
  buildRadarAxes,
  getPedagogicalArchetype,
  type UseRadarProfileProps,
} from './hooks/useRadarProfile';

export {
  AXES_ORDER,
  getAxisConfig,
  buildRadarAxes,
  getPedagogicalArchetype,
  type RadarAxis,
};

export function DirectionalDiamondSvg({
  axes,
  size,
  muted = false,
  empty = false,
  showLabels = false,
}: {
  axes: RadarAxis[];
  size: number;
  muted?: boolean;
  empty?: boolean;
  showLabels?: boolean;
}) {
  const VIEW_SIZE = showLabels ? 250 : 100;
  const CENTER = VIEW_SIZE / 2;
  const RADIUS = showLabels ? 86 : 38;

  const nVal = axes[0]?.value ?? null;
  const eVal = axes[1]?.value ?? null;
  const sVal = axes[2]?.value ?? null;
  const wVal = axes[3]?.value ?? null;

  const maxVal = Math.max(nVal ?? 0, eVal ?? 0, sVal ?? 0, wVal ?? 0);

  const BASELINE = 50;
  const calcRadius = (v: number | null) => {
    if (v == null || v <= 0) return 0;
    const ratio = Math.max(0.18, Math.min(1.0, (Math.max(BASELINE, v) - BASELINE) / (100 - BASELINE)));
    return RADIUS * ratio;
  };

  const rN = calcRadius(nVal);
  const rE = calcRadius(eVal);
  const rS = calcRadius(sVal);
  const rW = calcRadius(wVal);

  const diamondPoints = `${CENTER},${CENTER - rN} ${CENTER + rE},${CENTER} ${CENTER},${CENTER + rS} ${CENTER - rW},${CENTER}`;

  const base50Points = `${CENTER},${CENTER - RADIUS * 0.5} ${CENTER + RADIUS * 0.5},${CENTER} ${CENTER},${CENTER + RADIUS * 0.5} ${CENTER - RADIUS * 0.5},${CENTER}`;
  const base100Points = `${CENTER},${CENTER - RADIUS} ${CENTER + RADIUS},${CENTER} ${CENTER},${CENTER + RADIUS} ${CENTER - RADIUS},${CENTER}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
      className="overflow-visible select-none"
    >
      <polygon
        points={base50Points}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.12}
        strokeWidth={0.8}
        strokeDasharray="3 2"
      />

      <polygon
        points={base100Points}
        fill="none"
        stroke="currentColor"
        strokeOpacity={empty ? 0.35 : 0.25}
        strokeWidth={showLabels ? 1.0 : 1.2}
      />

      <line
        x1={CENTER}
        y1={CENTER - RADIUS}
        x2={CENTER}
        y2={CENTER + RADIUS}
        stroke="currentColor"
        strokeOpacity={empty ? 0.3 : 0.2}
        strokeWidth={showLabels ? 0.8 : 1.0}
      />
      <line
        x1={CENTER - RADIUS}
        y1={CENTER}
        x2={CENTER + RADIUS}
        y2={CENTER}
        stroke="currentColor"
        strokeOpacity={empty ? 0.3 : 0.2}
        strokeWidth={showLabels ? 0.8 : 1.0}
      />

      {!empty && (
        <>
          <polygon
            points={diamondPoints}
            fill="currentColor"
            fillOpacity={muted ? 0.12 : 0.24}
            stroke="currentColor"
            strokeWidth={showLabels ? 1.8 : 2.0}
            strokeLinejoin="round"
            strokeOpacity={muted ? 0.5 : 0.95}
          />

          <circle cx={CENTER} cy={CENTER - rN} r={maxVal > 0 && nVal === maxVal ? 3.5 : 2.5} fill="currentColor" />
          <circle cx={CENTER + rE} cy={CENTER} r={maxVal > 0 && eVal === maxVal ? 3.5 : 2.5} fill="currentColor" />
          <circle cx={CENTER} cy={CENTER + rS} r={maxVal > 0 && sVal === maxVal ? 3.5 : 2.5} fill="currentColor" />
          <circle cx={CENTER - rW} cy={CENTER} r={maxVal > 0 && wVal === maxVal ? 3.5 : 2.5} fill="currentColor" />

          {maxVal > 0 && (
            <circle
              cx={
                nVal === maxVal
                  ? CENTER
                  : eVal === maxVal
                  ? CENTER + rE
                  : sVal === maxVal
                  ? CENTER
                  : CENTER - rW
              }
              cy={
                nVal === maxVal
                  ? CENTER - rN
                  : eVal === maxVal
                  ? CENTER
                  : sVal === maxVal
                  ? CENTER + rS
                  : CENTER
              }
              r={6}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              strokeOpacity={0.6}
              className="animate-pulse"
            />
          )}
        </>
      )}

      <circle
        cx={CENTER}
        cy={CENTER}
        r={showLabels ? 3.0 : 2.0}
        fill="currentColor"
        fillOpacity={empty ? 0.4 : 0.75}
      />

      {showLabels && (
        <>
          <text
            x={CENTER}
            y={CENTER - RADIUS - 8}
            textAnchor="middle"
            className="text-micro select-none"
          >
            <tspan className="fill-theme-muted font-sans font-medium">{axes[0]?.label || m.radar_dim_depth()} </tspan>
            <tspan className="fill-theme-foreground font-mono font-bold">{nVal != null ? Math.round(nVal) : '—'}</tspan>
          </text>

          <text
            x={CENTER + RADIUS + 8}
            y={CENTER + 3.5}
            textAnchor="start"
            className="text-micro select-none"
          >
            <tspan className="fill-theme-muted font-sans font-medium">{axes[1]?.label || m.radar_dim_source()} </tspan>
            <tspan className="fill-theme-foreground font-mono font-bold">{eVal != null ? Math.round(eVal) : '—'}</tspan>
          </text>

          <text
            x={CENTER}
            y={CENTER + RADIUS + 18}
            textAnchor="middle"
            className="text-micro select-none"
          >
            <tspan className="fill-theme-muted font-sans font-medium">{axes[2]?.label || m.radar_dim_clarity()} </tspan>
            <tspan className="fill-theme-foreground font-mono font-bold">{sVal != null ? Math.round(sVal) : '—'}</tspan>
          </text>

          <text
            x={CENTER - RADIUS - 8}
            y={CENTER + 3.5}
            textAnchor="end"
            className="text-micro select-none"
          >
            <tspan className="fill-theme-foreground font-mono font-bold">{wVal != null ? Math.round(wVal) : '—'} </tspan>
            <tspan className="fill-theme-muted font-sans font-medium">{axes[3]?.label || m.radar_dim_system()}</tspan>
          </text>
        </>
      )}
    </svg>
  );
}

const AXIS_ICONS: Record<string, string> = {
  depth: '🏛️',
  codeFidelity: '🔬',
  pedagogy: '💡',
  coverage: '📖',
};

export interface ReviewHistoryDisplayItem {
  id: string;
  timestamp: string;
  trigger: 'owner_manual' | 'platform_patrol' | 'initial_publish' | string;
  previousScore?: number;
  newScore: number;
  reason?: string;
  operatorRole?: string;
  model?: string;
}

export interface RepoScoreRadarPanelProps extends UseRadarProfileProps {
  editionLabel?: string;
  className?: string;
  compact?: boolean;
  reReviewRemaining?: number;
  onReReview?: () => void;
  isReReviewing?: boolean;
  reviewHistory?: ReviewHistoryDisplayItem[];
  pendingReview?: boolean;
}

export function RepoScoreRadarPanel({
  reviewPipeline,
  reviewLlm,
  recScore,
  editionLabel,
  className,
  compact = true,
  reReviewRemaining,
  onReReview,
  isReReviewing = false,
  reviewHistory,
  pendingReview = false,
}: RepoScoreRadarPanelProps) {
  const [showHistory, setShowHistory] = useState(false);
  const historyList = Array.isArray(reviewHistory) ? reviewHistory : [];

  const { hasScores, axes, archetype } = useRadarProfile({
    reviewPipeline,
    reviewLlm,
  });

  if (!hasScores) {
    if (!pendingReview) return null;

    const emptyAxes = buildRadarAxes(null, null);

    return (
      <div
        className={cn(
          compact
            ? 'p-3 sm:p-3.5 rounded-xl bg-theme-bg/60 border border-theme-border/50 space-y-2.5 font-sans'
            : 'p-4 sm:p-5 rounded-2xl bg-theme-bg/60 border border-theme-border/50 space-y-4 font-sans',
          className
        )}
      >
        <div className={cn('flex items-center justify-between gap-2 flex-wrap', compact ? 'pb-2 border-b border-theme-border/30' : 'pb-3 border-b border-theme-border/40')}>
          <div className="flex items-center gap-2">
            <p className="text-xs font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 text-theme-primary" />
              <span>{m.radar_profile_title()}</span>
            </p>
            {editionLabel && (
              <span className="font-mono text-micro px-2 py-0.5 rounded bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-bold shrink-0">
                {editionLabel}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className="px-2 py-0.5 rounded text-micro font-sans font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20 shadow-2xs inline-flex items-center gap-1">
              <RotateCw className="w-2.5 h-2.5 animate-spin" />
              <span>{m.radar_status_evaluating()}</span>
            </span>
          </div>
        </div>

        <div className={cn('grid grid-cols-1 md:grid-cols-12 items-center', compact ? 'gap-3 sm:gap-4' : 'gap-5')}>
          <div className="md:col-span-5 flex justify-center text-theme-primary/70 py-0.5">
            <DirectionalDiamondSvg axes={emptyAxes} size={compact ? 230 : 260} empty showLabels />
          </div>

          <div className={cn('md:col-span-7', compact ? 'space-y-2' : 'space-y-3')}>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-theme-foreground flex items-center gap-1.5">
                <RotateCw className="w-3 h-3 animate-spin text-amber-500 shrink-0" />
                <span>{m.radar_status_evaluating()}</span>
              </p>
              <p className="text-xs text-theme-muted leading-relaxed font-sans">
                {m.radar_evaluating_desc()}
              </p>
            </div>

            <div className={cn('pt-0.5', compact ? 'space-y-1.5' : 'space-y-2')}>
              <div className={cn('rounded-lg bg-theme-surface/50 border border-dashed border-theme-border/60 text-xs flex items-center gap-2', compact ? 'px-2 py-1.5' : 'p-2.5 rounded-xl')}>
                <span className="inline-block px-1.5 py-0.5 rounded text-micro font-bold bg-theme-primary/10 text-theme-primary select-none shrink-0">
                  {m.radar_highlight_badge()}
                </span>
                <span className="text-theme-muted text-micro font-sans">{m.radar_evaluating_placeholder()}</span>
              </div>

              <div className={cn('rounded-lg bg-theme-surface/50 border border-dashed border-theme-border/60 text-xs flex items-center gap-2', compact ? 'px-2 py-1.5' : 'p-2.5 rounded-xl')}>
                <span className="inline-block px-1.5 py-0.5 rounded text-micro font-bold bg-theme-bg border border-theme-border text-theme-muted select-none shrink-0">
                  {m.radar_audience_badge()}
                </span>
                <span className="text-theme-muted text-micro font-sans">{m.radar_evaluating_placeholder()}</span>
              </div>
            </div>

            {onReReview && (
              <div className="pt-2 border-t border-theme-border/40 text-xs flex items-center justify-between gap-2">
                <span className="text-micro text-theme-muted font-sans">
                  {m.radar_re_review_hint()}
                </span>
                <button
                  type="button"
                  onClick={onReReview}
                  disabled={isReReviewing || (typeof reReviewRemaining === 'number' && reReviewRemaining <= 0)}
                  title={typeof reReviewRemaining === 'number' && reReviewRemaining <= 0 ? m.radar_re_review_depleted() : m.radar_re_review_prompt_tooltip({ remaining: reReviewRemaining ?? 3 })}
                  className="px-2.5 py-1 rounded-lg text-micro font-sans font-medium transition-colors border border-theme-border/60 bg-theme-surface hover:bg-theme-primary/10 hover:border-theme-primary/30 text-theme-muted hover:text-theme-primary disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5 shadow-2xs cursor-pointer shrink-0"
                >
                  {isReReviewing ? (
                    <>
                      <RotateCw className="w-3 h-3 animate-spin text-theme-primary" />
                      <span>{m.radar_re_reviewing()}</span>
                    </>
                  ) : (
                    <>
                      <RotateCw className="w-3 h-3" />
                      <span>{m.radar_re_review_btn({ remaining: reReviewRemaining ?? 3 })}</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const highlight = reviewLlm?.coreHighlight || reviewLlm?.summary;
  const audience = reviewLlm?.targetAudience;

  return (
    <div
      className={cn(
        compact
          ? 'p-3 sm:p-3.5 rounded-xl bg-theme-bg/60 border border-theme-border/50 space-y-2.5 font-sans'
          : 'p-4 sm:p-5 rounded-2xl bg-theme-bg/60 border border-theme-border/50 space-y-4 font-sans',
        className
      )}
    >
      <div className={cn('flex items-center justify-between gap-2 flex-wrap', compact ? 'pb-2 border-b border-theme-border/30' : 'pb-3 border-b border-theme-border/40')}>
        <div className="flex items-center gap-2">
          <p className="text-xs font-mono text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-theme-primary" />
            <span>{m.radar_profile_title()}</span>
          </p>
          {editionLabel && (
            <span className="font-mono text-micro px-2 py-0.5 rounded bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-bold shrink-0">
              {editionLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <span className="px-2 py-0.5 rounded text-micro font-sans font-semibold bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shadow-2xs">
            {archetype.label}
          </span>
          {typeof recScore === 'number' && recScore > 0 && (
            <span className="px-2 py-0.5 rounded text-micro font-mono border border-theme-border bg-theme-surface text-theme-foreground/80 shadow-2xs">
              {Math.round(recScore)}
            </span>
          )}
        </div>
      </div>

      <div className={cn('grid grid-cols-1 md:grid-cols-12 items-center', compact ? 'gap-3 sm:gap-4' : 'gap-5')}>
        <div className="md:col-span-5 flex justify-center text-theme-primary py-0.5">
          <DirectionalDiamondSvg axes={axes} size={compact ? 230 : 260} showLabels />
        </div>

        <div className={cn('md:col-span-7', compact ? 'space-y-2' : 'space-y-3')}>
          {archetype.desc && (
            <p className="text-xs text-theme-muted leading-relaxed font-sans line-clamp-2">
              {archetype.desc}
            </p>
          )}

          {(highlight || audience) && (
            <div className={cn('pt-0.5', compact ? 'space-y-1.5' : 'space-y-2')}>
              {highlight && (
                <div className={cn('rounded-lg bg-theme-surface/80 border border-theme-border/50 text-xs leading-relaxed', compact ? 'px-2 py-1.5' : 'p-2.5 rounded-xl')}>
                  <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded text-micro font-bold bg-theme-primary/10 text-theme-primary select-none align-baseline">
                    {m.radar_highlight_badge()}
                  </span>
                  <span className="font-medium text-theme-foreground/90">{highlight}</span>
                </div>
              )}
              {audience && (
                <div className={cn('rounded-lg bg-theme-surface/80 border border-theme-border/50 text-xs leading-relaxed', compact ? 'px-2 py-1.5' : 'p-2.5 rounded-xl')}>
                  <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded text-micro font-bold bg-theme-bg border border-theme-border text-theme-muted select-none align-baseline">
                    {m.radar_audience_badge()}
                  </span>
                  <span className="font-medium text-theme-foreground/80">{audience}</span>
                </div>
              )}
            </div>
          )}

          {!compact && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              {axes.map((axis) => (
                <div
                  key={axis.key}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-theme-surface/70 border border-theme-border/40 text-xs font-mono"
                  title={axis.comment || axis.description}
                >
                  <span className="text-theme-muted font-sans text-micro truncate flex items-center gap-1">
                    <span>{AXIS_ICONS[axis.key] || '•'}</span>
                    <span>{axis.label}</span>
                  </span>
                  <span className="font-bold text-theme-foreground ml-1.5 shrink-0">
                    {axis.value != null ? Math.round(axis.value) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(onReReview || historyList.length > 0) && (
            <div className="pt-2 border-t border-theme-border/40 text-xs space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-micro text-theme-muted font-sans">
                    {m.radar_re_review_hint()}
                  </span>
                  {historyList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowHistory((prev) => !prev)}
                      className="inline-flex items-center gap-1 text-micro font-sans text-theme-muted hover:text-theme-foreground bg-theme-surface px-1.5 py-0.5 rounded border border-theme-border/50 hover:border-theme-border transition-colors cursor-pointer"
                      title={m.radar_history_tooltip()}
                    >
                      <History className="w-2.5 h-2.5" />
                      <span>{m.radar_history_count({ count: historyList.length })}</span>
                      <ChevronDown className={cn('w-2.5 h-2.5 transition-transform', showHistory && 'rotate-180')} />
                    </button>
                  )}
                </div>

                {onReReview && (
                  <button
                    type="button"
                    onClick={onReReview}
                    disabled={isReReviewing || (typeof reReviewRemaining === 'number' && reReviewRemaining <= 0)}
                    title={typeof reReviewRemaining === 'number' && reReviewRemaining <= 0 ? m.radar_re_review_depleted() : m.radar_re_review_prompt_tooltip({ remaining: reReviewRemaining ?? 3 })}
                    className="px-2.5 py-1 rounded-lg text-micro font-sans font-medium transition-colors border border-theme-border/60 bg-theme-surface hover:bg-theme-primary/10 hover:border-theme-primary/30 text-theme-muted hover:text-theme-primary disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5 shadow-2xs cursor-pointer shrink-0"
                  >
                    {isReReviewing ? (
                      <>
                        <RotateCw className="w-3 h-3 animate-spin text-theme-primary" />
                        <span>{m.radar_re_reviewing()}</span>
                      </>
                    ) : (
                      <>
                        <RotateCw className="w-3 h-3" />
                        <span>{m.radar_re_review_btn({ remaining: reReviewRemaining ?? 3 })}</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {showHistory && historyList.length > 0 && (
                <div className="p-2 rounded-lg bg-theme-bg/80 border border-theme-border/60 text-micro font-sans space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar animate-in fade-in duration-200">
                  <div className="text-theme-muted font-medium text-micro pb-1 border-b border-theme-border/30 flex justify-between items-center">
                    <span>{m.radar_history_title()}</span>
                    <span>{m.radar_history_total({ count: historyList.length })}</span>
                  </div>
                  {historyList.map((item) => {
                    const isOwner = item.trigger === 'owner_manual';
                    const dateStr = item.timestamp
                      ? new Date(item.timestamp).toLocaleString(undefined, {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';
                    return (
                      <div key={item.id} className="flex flex-col gap-0.5 py-1 border-b border-theme-border/20 last:border-b-0">
                        <div className="flex items-center justify-between text-micro">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'px-1 py-0.5 rounded font-bold text-micro',
                                isOwner
                                  ? 'bg-theme-primary/15 text-theme-primary'
                                  : 'bg-theme-surface border border-theme-border text-theme-muted'
                              )}
                            >
                              {isOwner ? m.radar_history_owner() : m.radar_history_system()}
                            </span>
                            <span className="font-semibold text-theme-foreground">
                              {typeof item.previousScore === 'number' ? `${m.radar_score_points({ score: item.previousScore })} → ` : ''}
                              {m.radar_score_points({ score: item.newScore })}
                            </span>
                          </span>
                          <span className="text-theme-muted text-micro">{dateStr}</span>
                        </div>
                        {item.reason && (
                          <div className="text-theme-muted text-micro pl-1 leading-tight line-clamp-1">
                            {m.radar_reason_prefix()}{item.reason}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
