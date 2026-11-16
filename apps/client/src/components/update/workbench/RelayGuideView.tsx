'use client';

import React, { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  Sparkles,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import type { RelayOutlineChapter, RelayOutlineNode } from './useUpdateWorkbench';
import {
  findRecommendedRelayNode,
  formatRelayDisplayTitle,
  docPathToSlug,
} from './relay-recommendation';
import { useRelayTaskStore } from '@/lib/stores/relay-task-store';

export interface RelayGuideViewProps {
  owner: string;
  repo: string;
  outline: RelayOutlineChapter[];
  loadingJobs: boolean;
  initialJobId?: string | null;
  handleSingleClaim?: (node: RelayOutlineNode) => void;
  claimingNodeId?: string | null;
}

export function RelayGuideView({
  owner,
  repo,
  outline,
  loadingJobs,
  initialJobId,
  handleSingleClaim,
  claimingNodeId,
}: RelayGuideViewProps) {
  // 自定义选章抽屉展开状态（默认收起，聚焦推荐）
  const [showCustomList, setShowCustomList] = useState(false);

  // 拓扑缝合推荐计算
  const recommendation = useMemo(() => {
    return findRecommendedRelayNode(outline, initialJobId);
  }, [outline, initialJobId]);

  // 全局统计
  const allNodes = useMemo(() => outline.flatMap((ch) => ch.nodes || []), [outline]);
  const totalCount = allNodes.length;
  const processedCount = allNodes.filter((n) => n.status === 'PROCESSED').length;
  const claimableCount = allNodes.filter((n) => n.status === 'UNPROCESSED').length;

  const isClaimingAny = claimingNodeId !== null && claimingNodeId !== undefined;

  const activeTask = useRelayTaskStore((s) => s.activeTask);

  // 转录秒表计时器（基于物理 startedAt，切窗/最小化不重置）
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isClaimingAny) {
      setElapsedSeconds(0);
      return;
    }
    const compute = () => {
      if (activeTask?.startedAt && activeTask.owner === owner && activeTask.repo === repo) {
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activeTask.startedAt) / 1000)));
      } else {
        setElapsedSeconds((s) => s + 1);
      }
    };
    compute();
    const timer = setInterval(compute, 1000);
    return () => clearInterval(timer);
  }, [isClaimingAny, activeTask?.startedAt, activeTask?.owner, activeTask?.repo, owner, repo]);

  // 动态阶段指示器
  const stages = useMemo(() => {
    return [
      {
        id: 1,
        title: m.relay_stage_1(),
        done: elapsedSeconds >= 2,
        active: elapsedSeconds < 2,
      },
      {
        id: 2,
        title: m.relay_stage_2(),
        done: elapsedSeconds >= 6,
        active: elapsedSeconds >= 2 && elapsedSeconds < 6,
      },
      {
        id: 3,
        title: m.relay_stage_3(),
        done: elapsedSeconds >= 32,
        active: elapsedSeconds >= 6 && elapsedSeconds < 32,
      },
      {
        id: 4,
        title: m.relay_stage_4(),
        done: elapsedSeconds >= 42,
        active: elapsedSeconds >= 32 && elapsedSeconds < 42,
      },
      {
        id: 5,
        title: m.relay_stage_5(),
        done: false,
        active: elapsedSeconds >= 42,
      },
    ];
  }, [elapsedSeconds]);

  // 加载中
  if (loadingJobs) {
    return (
      <div className="flex-1 min-h-[260px] flex flex-col items-center justify-center gap-2.5 text-theme-muted p-8">
        <Loader2 className="w-5 h-5 animate-spin text-theme-primary" />
        <span className="text-xs font-mono">{m.workbench_batch_status_checking()}</span>
      </div>
    );
  }

  // 全书已全部完结
  if (!loadingJobs && totalCount > 0 && claimableCount === 0) {
    return (
      <div className="flex-1 min-h-[260px] flex flex-col items-center justify-center gap-3 text-center p-8">
        <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center text-emerald-600">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h4 className="text-sm font-serif font-bold text-theme-foreground">
            {m.relay_all_completed_title()}
          </h4>
          <p className="text-xs text-theme-muted max-w-sm">
            {m.relay_all_completed_desc({ totalCount })}
          </p>
        </div>
        <Link
          href={`/docs/${owner}/${repo}`}
          className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-theme-primary text-theme-primary-fg text-xs font-bold shadow-sm hover:opacity-90 transition-all cursor-pointer"
        >
          <BookOpen className="w-4 h-4" />
          <span>{m.relay_read_full_tutorial()}</span>
        </Link>
      </div>
    );
  }

  // 大纲空状态
  if (!loadingJobs && totalCount === 0) {
    return (
      <div className="flex-1 min-h-[200px] flex flex-col items-center justify-center gap-2 text-center p-8 text-theme-muted text-xs">
        <span>{m.relay_no_outline()}</span>
      </div>
    );
  }

  // 纯净章节与节次标题（剥除多余的重复前缀）
  const cleanChapterName = recommendation
    ? recommendation.chapterDisplayTitle
        .replace(/^(?:第\s*\d+\s*章|Chapter\s*\d+)\s*[：:·\-\s]?\s*/iu, '')
        .trim()
    : '';
  const cleanSectionTitle = recommendation
    ? (recommendation.node.title || recommendation.displayTitle || '')
        .replace(/^(?:第\s*\d+\s*节|Section\s*\d+)\s*[：:·\-\s]?\s*/iu, '')
        .trim()
    : '';

  return (
    <div className="flex-1 min-h-0 flex flex-col justify-between p-5 overflow-y-auto">
      {/* 核心英雄区：推荐接力章节卡片 */}
      {recommendation ? (
        <div className="rounded-2xl border border-theme-border/70 bg-theme-surface/40 p-5 shadow-2xs space-y-4">
          {/* 单行极简顶栏：章节定位导航 + 推荐微标 */}
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-1.5 text-theme-muted min-w-0">
              <span className="font-semibold text-theme-foreground/90 truncate">
                {cleanChapterName
                  ? `${m.relay_chapter_index({ index: recommendation.chapterIndex + 1 })} · ${cleanChapterName}`
                  : m.relay_chapter_index({ index: recommendation.chapterIndex + 1 })}
              </span>
              <span className="text-theme-border">/</span>
              <span className="font-mono text-micro text-theme-muted shrink-0">
                {m.relay_section_index({ index: recommendation.nodeIndexInChapter + 1 })}
              </span>
            </div>

            <span className="inline-flex items-center gap-1 text-micro font-bold text-theme-primary shrink-0">
              <Sparkles className="w-3 h-3" />
              <span>{m.relay_recommended_badge()}</span>
            </span>
          </div>

          {/* 纯净主标题 */}
          <div>
            <h3 className="text-base sm:text-lg font-serif font-bold text-theme-foreground tracking-tight">
              {cleanSectionTitle}
            </h3>
          </div>

          {/* 核心单一 CTA 主区域：转录中显示动态 5 步进度看板与秒表；未转录显示立即认领按钮 */}
          {claimingNodeId === recommendation.node.id ? (
            <div className="rounded-xl border border-theme-primary/30 bg-theme-bg/90 p-4 space-y-3.5 shadow-2xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-theme-primary">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{m.relay_transcribing_active()}</span>
                </div>
                <span className="font-mono text-xs px-2.5 py-0.5 rounded-full bg-theme-primary/10 text-theme-primary font-bold border border-theme-primary/20">
                  {m.relay_elapsed_seconds({ seconds: elapsedSeconds })}
                </span>
              </div>

              {/* 5 阶段步进进度展示 */}
              <div className="space-y-1.5 pt-0.5">
                {stages.map((st) => (
                  <div key={st.id} className="flex items-center gap-2 text-micro">
                    {st.done ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    ) : st.active ? (
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-theme-primary border-t-transparent animate-spin shrink-0" />
                    ) : (
                      <span className="w-3.5 h-3.5 rounded-full border border-theme-border/60 bg-theme-surface shrink-0" />
                    )}
                    <span
                      className={cn(
                        'truncate font-medium transition-colors',
                        st.done && 'text-emerald-600 dark:text-emerald-400 font-medium',
                        st.active && 'text-theme-primary font-bold',
                        !st.done && !st.active && 'text-theme-muted/50'
                      )}
                    >
                      {st.title}
                    </span>
                  </div>
                ))}
              </div>

              <p className="text-micro text-theme-muted/60 text-center pt-0.5">
                {m.relay_generating_hint()}
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleSingleClaim?.(recommendation.node)}
              disabled={isClaimingAny}
              className="w-full py-2.5 sm:py-3 rounded-xl bg-theme-primary text-theme-primary-fg hover:opacity-90 active:scale-[0.99] text-xs sm:text-sm font-bold shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>{m.relay_claim_now()}</span>
            </button>
          )}
        </div>
      ) : null}

      {/* 次级入口：自定义自选章节（弱化、小尺寸、可折叠） */}
      <div className="mt-4 pt-2 border-t border-theme-border/40 flex flex-col items-center">
        <button
          type="button"
          onClick={() => setShowCustomList(!showCustomList)}
          className="inline-flex items-center gap-1 text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer py-1 px-2.5 rounded-lg hover:bg-theme-surface"
        >
          <span>{m.relay_choose_custom_chapters({ count: claimableCount })}</span>
          <ChevronDown
            className={cn(
              'w-3.5 h-3.5 transition-transform duration-200',
              showCustomList && 'rotate-180'
            )}
          />
        </button>

        {/* 展开的轻量自选章节列表 */}
        {showCustomList && (
          <div className="w-full mt-2.5 max-h-52 overflow-y-auto rounded-xl border border-theme-border/60 bg-theme-surface/30 p-2 space-y-3">
            {outline.map((chapter) => {
              const nodes = chapter.nodes || [];
              if (nodes.length === 0) return null;

              return (
                <div key={chapter.id} className="space-y-1">
                  <div className="text-micro font-serif font-bold text-theme-muted px-1">
                    {chapter.title}
                  </div>
                  <div className="divide-y divide-theme-border/25 rounded-lg border border-theme-border/40 bg-theme-bg overflow-hidden">
                    {nodes.map((node, nodeIdx) => {
                      const isProcessed = node.status === 'PROCESSED';
                      const isClaimed = node.status === 'CLAIMED';
                      const isUnprocessed = node.status === 'UNPROCESSED';
                      const isRecommended = recommendation?.node.id === node.id;
                      const isClaimingThis = claimingNodeId === node.id;
                      const formattedTitle = formatRelayDisplayTitle(
                        node.title,
                        node.path,
                        nodeIdx
                      );
                      const readUrl = `/docs/${owner}/${repo}/${docPathToSlug(node.path)}`;

                      return (
                        <div
                          key={node.id}
                          className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            <span className="truncate font-medium text-theme-foreground">
                              {formattedTitle}
                            </span>
                            {isRecommended && (
                              <span className="shrink-0 text-micro px-1 py-0.2 rounded bg-theme-primary/10 text-theme-primary font-bold">
                                {m.relay_recommended_badge()}
                              </span>
                            )}
                          </div>

                          <div className="shrink-0 flex items-center gap-1.5">
                            {isProcessed && (
                              <Link
                                href={readUrl}
                                target="_blank"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                              >
                                <span>{m.common_read()}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </Link>
                            )}

                            {isClaimed && (
                              <span className="text-micro text-theme-muted inline-flex items-center gap-0.5">
                                <Users className="w-2.5 h-2.5 text-theme-primary" />
                                <span>{m.relay_status_in_progress()}</span>
                              </span>
                            )}

                            {isUnprocessed && handleSingleClaim && (
                              <button
                                type="button"
                                onClick={() => handleSingleClaim(node)}
                                disabled={isClaimingAny}
                                className="px-2 py-0.5 rounded bg-theme-primary/10 hover:bg-theme-primary text-theme-primary hover:text-theme-primary-fg border border-theme-primary/20 text-micro font-bold transition-all cursor-pointer disabled:opacity-40"
                              >
                                {isClaimingThis ? (
                                  <span className="inline-flex items-center gap-1 font-mono">
                                    <Loader2 className="w-2.5 h-2.5 animate-spin inline mr-0.5" />
                                    <span>{m.relay_transcribing_time({ seconds: elapsedSeconds })}</span>
                                  </span>
                                ) : (
                                  <span>{m.relay_action_transcribe()}</span>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
