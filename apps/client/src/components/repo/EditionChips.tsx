'use client';

/**
 * 讲法（edition）展示组件族：chips 行 + 就地气泡浮层 (Popover) + 居中对话框 (Dialog)。
 * 同一仓库的多讲法行在展示层聚合为一个区域（数据形状见 lib/home-data.ts EditionChip）；
 * 单讲法时调用方不渲染本组件（卡片零变化）。书架 / 广场 / 项目列表共用。
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  GraduationCap,
  Microscope,
  ListChecks,
  BookMarked,
  ArrowLeftRight,
  Layers,
  Plus,
  Check,
  BookOpen,
  X,
  Trash2,
  ChevronDown,
  RotateCw,
  FileText,
  Crown,
  Loader2,
} from 'lucide-react';
import type { EditionChip } from '@/lib/home-data';
import { resolveEditionChipDisplayLabel } from '@/lib/edition';
import { TRANSCRIPTION_PRESETS } from '@/lib/transcription-presets';
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogViewport,
  DialogPopup,
} from '@/components/ui/dialog';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { useUserCreditsStore } from '@/lib/stores/user-credits-store';
import * as m from '@/paraglide/messages';

/** 注册表 icon 名 → lucide 组件（唯一映射点，禁止散落） */
const EDITION_ICON_MAP = {
  'graduation-cap': GraduationCap,
  microscope: Microscope,
  'list-checks': ListChecks,
  'book-marked': BookMarked,
  'arrow-left-right': ArrowLeftRight,
  layers: Layers,
} as const;

const FALLBACK_TONE = 'text-theme-muted bg-theme-surface border-theme-border';

/** 讲法 → 图标 + 色调（预设注册表驱动；自定义讲法回落 layers 图标） */
export function editionVisual(presetId: string | null): {
  Icon: React.ComponentType<{ className?: string }>;
  toneClass: string;
} {
  const preset = presetId ? TRANSCRIPTION_PRESETS.find((p) => p.id === presetId) : undefined;
  if (!preset) {
    return { Icon: EDITION_ICON_MAP.layers, toneClass: FALLBACK_TONE };
  }
  return {
    Icon: EDITION_ICON_MAP[preset.icon] ?? EDITION_ICON_MAP.layers,
    toneClass: preset.toneClass,
  };
}

/** 行级收藏请求（POST /api/repos {action, repositoryId}；本地状态由调用方回调更新） */
export async function toggleEditionSave(chip: EditionChip): Promise<boolean> {
  try {
    const res = await api.post<{ fee?: number; alreadySaved?: boolean; signupGift?: number; balance?: number }>('/api/repos', {
      action: chip.isSaved ? 'unsave' : 'save',
      repositoryId: chip.id,
    });
    if (chip.isSaved) {
      toastManager.add({ type: 'success', title: m.toast_project_removed() });
    } else {
      const paid = res?.fee ?? 0;
      const gift = res?.signupGift ?? 0;
      if (paid > 0 || typeof res?.balance === 'number') {
        useUserCreditsStore.getState().deductCredits(paid, res?.balance);
      }
      if (gift > 0) {
        useUserCreditsStore.getState().addCredits(gift);
      }
      useUserCreditsStore.getState().invalidate().catch(() => {});

      const descParts: string[] = [];
      if (paid > 0) descParts.push(m.shelf_fee_paid({ count: paid }));
      if (gift > 0) descParts.push(m.shelf_signup_gift({ count: gift }));
      toastManager.add({
        type: 'success',
        title: m.toast_project_added(),
        description: descParts.length > 0 ? descParts.join(' · ') : undefined,
      });
    }
    return true;
  } catch (err: any) {
    if (err?.code === 'INSUFFICIENT_BALANCE') {
      toastManager.add({
        type: 'error',
        title: m.shelf_insufficient_title(),
        description: err?.message || m.shelf_insufficient_desc(),
      });
      return false;
    }
    toastManager.add({ type: 'error', title: m.toast_action_failed(), description: err?.message || m.common_retry_later() });
    return false;
  }
}

export interface EditionListContentProps {
  editions: EditionChip[];
  owner?: string;
  repo?: string;
  activeEdition?: string;
  onSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onDeleted?: (chipId: string) => void;
  onPromoted?: (chip: EditionChip) => void;
  onCreateEdition?: () => void;
  onClose?: () => void;
  title?: string;
  canManage?: boolean;
}

/**
 * 讲法列表内容核心组件（Popover 与 Dialog 模态窗共享）
 */
export function EditionListContent({
  editions,
  owner,
  repo,
  activeEdition,
  onSavedChange,
  onDeleted,
  onPromoted,
  onCreateEdition,
  onClose,
  title,
  canManage,
}: EditionListContentProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const handleToggle = async (chip: EditionChip) => {
    setBusyId(chip.id);
    try {
      const ok = await toggleEditionSave(chip);
      if (ok) onSavedChange?.(chip, !chip.isSaved);
    } finally {
      setBusyId(null);
    }
  };

  const handlePromote = async (chip: EditionChip) => {
    const confirmMsg = m.edition_promote_confirm({ label: chip.label });
    if (!window.confirm(confirmMsg)) return;

    setPromotingId(chip.id);
    try {
      await api.post('/api/repos/promote-edition', { repoId: chip.id });
      toastManager.add({ type: 'success', title: m.edition_promote_success() });
      onPromoted?.(chip);
      onClose?.();
      const cleanUrl = chip.docUrl.split('?')[0];
      window.location.href = cleanUrl;
    } catch (err: any) {
      toastManager.add({
        type: 'error',
        title: m.edition_promote_failed(),
        description: err?.message,
      });
    } finally {
      setPromotingId(null);
    }
  };

  const handleDelete = async (chip: EditionChip) => {
    const confirmMsg = `${m.common_delete()}「${chip.label}」？`;
    if (!window.confirm(confirmMsg)) return;

    setDeletingId(chip.id);
    try {
      await api.delete(`/api/repos?id=${chip.id}&global=true`);
      toastManager.add({ type: 'success', title: m.toast_project_deleted() });
      onDeleted?.(chip.id);
      router.refresh();
      onClose?.();
    } catch (err: any) {
      toastManager.add({
        type: 'error',
        title: m.common_delete_failed(),
        description: err?.message,
      });
    } finally {
      setDeletingId(null);
    }
  };


  return (
    <div className="flex flex-col w-full bg-theme-bg text-left select-none">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between p-3.5 border-b border-theme-border/60 bg-theme-surface/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-theme-primary shrink-0" />
          <span className="font-serif font-bold text-xs text-theme-foreground truncate">
            {title || (repo ? `${repo} · ${m.edition_section_title()}` : m.edition_section_title())}
          </span>
          <span className="text-micro font-mono px-1.5 py-0.5 rounded-full bg-theme-primary/10 text-theme-primary font-medium shrink-0">
            {editions.length}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
              aria-label={m.common_close()}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 讲法版本卡片列表 */}
      <div className="max-h-[380px] overflow-y-auto custom-scrollbar p-2.5 space-y-2">
        {editions.map((chip) => {
          const { Icon, toneClass } = editionVisual(chip.presetId);
          const isFullyTranscribed = chip.chapterCount > 0 && chip.processedDocsCount >= chip.chapterCount;
          const isTranscribing = chip.chapterCount > 0 && chip.processedDocsCount > 0 && chip.processedDocsCount < chip.chapterCount;
          const transcriptionPercent = chip.chapterCount > 0
            ? Math.round((chip.processedDocsCount / chip.chapterCount) * 100)
            : 0;
          const readingProgress = chip.progress ?? 0;
          const isActive = activeEdition !== undefined && chip.edition === activeEdition;
          const isCustom = !chip.isDefault;

          return (
            <div
              key={chip.id}
              className={cn(
                'group relative rounded-xl border p-3 transition-all',
                isActive
                  ? 'border-theme-primary/70 bg-theme-primary/5 shadow-2xs'
                  : 'border-theme-border/60 bg-theme-surface/30 hover:bg-theme-surface hover:border-theme-primary/30'
              )}
            >
              {/* 行 1: 图标、标题、标签、激活标记 */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn('inline-flex items-center justify-center w-6 h-6 rounded-lg border shrink-0', toneClass)}>
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-sans font-bold text-theme-foreground truncate">
                    {resolveEditionChipDisplayLabel(chip)}
                  </span>
                  {chip.isDefault && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-sans font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shrink-0"
                      title={m.version_trial_current_badge()}
                    >
                      <Crown className="w-2.5 h-2.5" />
                      <span>{m.version_trial_current_badge()}</span>
                    </span>
                  )}
                  {chip.isSameSource && (
                    <span className="text-micro px-1 py-0.5 rounded bg-theme-bg border border-theme-border text-theme-muted shrink-0" title={m.repo_same_source_tooltip()}>
                      {m.repo_same_source_tag()}
                    </span>
                  )}
                </div>
                {isActive && (
                  <span className="text-theme-primary text-xs flex items-center gap-0.5 shrink-0" title={m.edition_state_selected()}>
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                  </span>
                )}
              </div>

              {/* 行 2: 真实进度度量与微型进度条（区分转录就绪与阅读进度） */}
              <div className="flex items-center justify-between text-caption text-theme-muted font-mono mb-2.5">
                <div className="flex items-center gap-2">
                  <span>{chip.chapterCount > 0 ? m.common_count_chapters({ count: chip.chapterCount }) : ''}</span>
                  <span className="text-theme-border/60">·</span>
                  {isFullyTranscribed ? (
                    <>
                      <span>{readingProgress > 0 ? m.tutorial_reading_progress({ progress: readingProgress }) : m.tutorial_unread()}</span>
                      {readingProgress > 0 && (
                        <div className="w-16 h-1 bg-theme-surface rounded-full overflow-hidden border border-theme-border/40 inline-block align-middle">
                          <div
                            className="h-full bg-theme-primary rounded-full transition-all"
                            style={{ width: `${Math.min(Math.max(readingProgress, 0), 100)}%` }}
                          />
                        </div>
                      )}
                    </>
                  ) : isTranscribing ? (
                    <>
                      <span>{m.tutorial_transcribed_progress({ done: chip.processedDocsCount, total: chip.chapterCount })}</span>
                      <div className="w-16 h-1 bg-theme-surface rounded-full overflow-hidden border border-theme-border/40 inline-block align-middle">
                        <div
                          className="h-full bg-amber-500 rounded-full transition-all"
                          style={{ width: `${Math.min(Math.max(transcriptionPercent, 0), 100)}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    <span className="text-theme-muted">{m.tutorial_untranscribed_details()}</span>
                  )}
                </div>
                {isTranscribing ? (
                  <span className="text-amber-500 font-sans font-medium text-micro flex items-center gap-1">
                    <RotateCw className="w-3 h-3 animate-spin" />
                    {m.relay_transcribing()}
                  </span>
                ) : !isFullyTranscribed ? (
                  <span className="text-sky-500 font-sans font-medium text-micro flex items-center gap-1">
                    <FileText className="w-3 h-3" />
                    {m.tutorial_untranscribed_badge()}
                  </span>
                ) : null}
              </div>

              {/* 行 3: 底部操作栏（进入阅读、收藏、删除） */}
              <div className="flex items-center justify-between pt-1 border-t border-theme-border/40 gap-2">
                <Link
                  href={chip.docUrl}
                  onClick={onClose}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-theme-primary text-theme-primary-fg font-sans font-bold text-xs hover:brightness-110 active:scale-95 transition-all shadow-2xs cursor-pointer"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{m.common_read()}</span>
                </Link>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busyId === chip.id}
                    onClick={() => handleToggle(chip)}
                    className={cn(
                      'p-1.5 rounded-lg text-xs font-sans transition-colors cursor-pointer disabled:opacity-50',
                      chip.isSaved
                        ? 'text-theme-primary hover:text-rose-500 hover:bg-rose-500/10'
                        : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface'
                    )}
                    title={
                      chip.isSaved
                        ? m.shelf_saved_remove()
                        : (chip.shelfFeeEstimate ?? 0) > 0
                          ? m.shelf_add_with_fee({ count: chip.shelfFeeEstimate ?? 0 })
                          : m.shelf_add_free()
                    }
                  >
                    {chip.isSaved ? (
                      <Check className="w-3.5 h-3.5 stroke-[2]" />
                    ) : (
                      <Plus className="w-3.5 h-3.5 stroke-[2]" />
                    )}
                  </button>

                  {isCustom && Boolean(chip.canManage ?? canManage) && (
                    <button
                      type="button"
                      disabled={promotingId === chip.id}
                      onClick={() => handlePromote(chip)}
                      className="p-1.5 rounded-lg text-theme-muted hover:text-theme-primary hover:bg-theme-primary/10 transition-colors cursor-pointer disabled:opacity-50"
                      title={m.edition_promote_to_primary()}
                      aria-label={m.edition_promote_to_primary()}
                    >
                      {promotingId === chip.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Crown className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}

                  {isCustom && (
                    <button
                      type="button"
                      disabled={deletingId === chip.id}
                      onClick={() => handleDelete(chip)}
                      className="p-1.5 rounded-lg text-theme-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer disabled:opacity-50"
                      title={m.common_delete()}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部新增入口 */}
      {onCreateEdition && (
        <div className="p-2.5 border-t border-theme-border/60 bg-theme-surface/20 shrink-0">
          <button
            type="button"
            onClick={() => {
              onClose?.();
              onCreateEdition();
            }}
            className="w-full px-3 py-1.5 rounded-xl border border-dashed border-theme-primary/40 bg-theme-primary/5 hover:bg-theme-primary/10 text-theme-primary font-serif font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{m.edition_chips_custom_create()}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export interface EditionPopoverProps {
  editions: EditionChip[];
  owner?: string;
  repo?: string;
  activeEdition?: string;
  onSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onDeleted?: (chipId: string) => void;
  onPromoted?: (chip: EditionChip) => void;
  onCreateEdition?: () => void;
  canManage?: boolean;
  trigger: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/**
 * 方案 A：就地气泡浮层（Popover）
 * 彻底替换全屏右抽屉，光标在哪里就在哪里弹出，无视线跳跃与全屏遮罩打断。
 */
export function EditionPopover({
  editions,
  owner,
  repo,
  activeEdition,
  onSavedChange,
  onDeleted,
  onPromoted,
  onCreateEdition,
  canManage,
  trigger,
  side = 'bottom',
  align = 'start',
  className,
}: EditionPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={React.isValidElement(trigger) ? trigger : undefined}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {!React.isValidElement(trigger) ? trigger : undefined}
      </PopoverTrigger>
      <PopoverPopup
        side={side}
        align={align}
        sideOffset={6}
        className={cn(
          'w-80 sm:w-96 max-w-[calc(100vw-2rem)] rounded-2xl bg-theme-bg border border-theme-border/80 shadow-2xl p-0 overflow-hidden text-left z-[100] focus:outline-none',
          className
        )}
      >
        <EditionListContent
          editions={editions}
          owner={owner}
          repo={repo}
          activeEdition={activeEdition}
          onSavedChange={onSavedChange}
          onDeleted={onDeleted}
          onPromoted={onPromoted}
          onCreateEdition={onCreateEdition}
          canManage={canManage}
          onClose={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

export interface EditionChipsRowProps {
  editions: EditionChip[];
  /** chips 上限（超出折叠进 Popover；默认 3） */
  maxInline?: number;
  /** 行级收藏成功后的状态回写（chips 数据不可变，由父层 setState） */
  onSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  /** 当前讲法 key（文档页切换器场景高亮用；广场/书架缺省不高亮） */
  activeEdition?: string;
  /** 紧凑模式（项目列表行内） */
  compact?: boolean;
  /** 「＋ 定制新版本」衍生导入入口 */
  onCreateEdition?: () => void;
  onDeleted?: (chipId: string) => void;
  onPromoted?: (chip: EditionChip) => void;
  canManage?: boolean;
}

/**
 * 讲法 chips 行 + 就地 Popover 气泡菜单入口。
 * - chip 点击 = 进入该讲法文档页（Link）
 * - 溢出部分点击就地展开精简气泡列表
 */
export function EditionChipsRow({
  editions,
  maxInline = 3,
  onSavedChange,
  activeEdition,
  compact = false,
  onCreateEdition,
  onDeleted,
  onPromoted,
  canManage,
}: EditionChipsRowProps) {
  if (!editions || editions.length <= 1) return null;

  const inlineChips = editions.slice(0, maxInline);
  const overflow = editions.length - inlineChips.length;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`flex flex-wrap items-center gap-1.5 ${compact ? 'text-xs' : 'text-xs'}`}
    >
      <span className="text-theme-muted font-sans font-medium shrink-0">{m.edition_chips_label()}</span>
      {inlineChips.map((chip) => {
        const { Icon, toneClass } = editionVisual(chip.presetId);
        const preset = chip.presetId ? TRANSCRIPTION_PRESETS.find((p) => p.id === chip.presetId) : undefined;
        const desc = preset?.description ? ` · ${preset.description}` : '';
        const isActive = activeEdition !== undefined && chip.edition === activeEdition;
        return (
          <Link
            key={chip.id}
            href={chip.docUrl}
            title={`${m.repo_same_source_title({ label: chip.label, sameSource: chip.isSameSource ? ' · ' + m.repo_same_source_tag() : '', saved: chip.isSaved ? ' · ' + m.repo_in_bookshelf() : '', progress: chip.progress || 0 })}${desc}`}
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 border rounded-md font-sans text-xs transition-all cursor-pointer ${
              isActive
                ? 'border-theme-primary/60 bg-theme-primary/10 text-theme-primary font-bold'
                : `${toneClass} hover:brightness-110`
            } ${chip.isSaved && !isActive ? 'ring-1 ring-inset ring-current/20' : ''}`}
          >
            <Icon className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            <span className="truncate max-w-32">{resolveEditionChipDisplayLabel(chip)}</span>
            {chip.isSameSource && (
              <span className="text-micro px-1 rounded-sm bg-theme-bg/60 border border-current/20 shrink-0" title={m.repo_same_source_tooltip()}>
                {m.repo_same_source_tag()}
              </span>
            )}
          </Link>
        );
      })}
      {overflow > 0 && (
        <EditionPopover
          editions={editions}
          activeEdition={activeEdition}
          onSavedChange={onSavedChange}
          onDeleted={onDeleted}
          onPromoted={onPromoted}
          onCreateEdition={onCreateEdition}
          canManage={canManage}
          side="bottom"
          align="start"
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-0.5 border border-theme-border/60 rounded-md text-theme-muted hover:text-theme-foreground hover:border-theme-border font-sans text-xs transition-all cursor-pointer"
            >
              +{overflow}
            </button>
          }
        />
      )}
    </div>
  );
}

export interface EditionDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editions: EditionChip[];
  onSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onCreateEdition?: () => void;
  onDeleted?: (chipId: string) => void;
  onPromoted?: (chip: EditionChip) => void;
  canManage?: boolean;
  owner?: string;
  repo?: string;
}

/**
 * 结构化版本管理弹窗（平替原有的居右大抽屉）：
 * 居中模态设计，提供清晰的列表与操作，消除原先从右侧滑出全屏暗色遮罩的笨重感。
 */
export function EditionDrawer({
  open,
  onOpenChange,
  editions,
  onSavedChange,
  onCreateEdition,
  onDeleted,
  onPromoted,
  canManage,
  owner,
  repo,
}: EditionDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPopup className="w-full max-w-md p-0 rounded-2xl bg-theme-bg border border-theme-border shadow-2xl overflow-hidden focus:outline-none">
            <EditionListContent
              editions={editions}
              owner={owner}
              repo={repo}
              onSavedChange={onSavedChange}
              onCreateEdition={onCreateEdition}
              onDeleted={onDeleted}
              onPromoted={onPromoted}
              canManage={canManage}
              onClose={() => onOpenChange(false)}
            />
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
