'use client';

/**
 * 文档页讲法（edition）组件：
 * - EditionAwareDocsLayout：DocsLayout 的客户端包装——读 ?edition= 并把 sidebar 树内的
 *   页面 URL 追加讲法参数（layout 无 searchParams，sidebar 跨讲法跳转不丢上下文）
 * - DocsEditionSwitcher：讲法切换 chips（当前讲法高亮，其余链到当前路径 + ?edition=）
 */

import React, { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Layers, Check, ExternalLink } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { editionVisual } from '@/components/repo/EditionChips';
import { resolveTranscriptionPreset } from '@/lib/transcription-presets';
import { useIngestQueueStore } from '@/lib/stores/ingest-queue-store';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import {
  formatEditionRelativeTime,
  formatChapterCount,
  formatWordCount,
} from '@/lib/format';

function resolveTeachingDepthLabel(depth?: string | null): string | null {
  if (!depth) return null;
  const trimmed = depth.trim();
  if (!trimmed) return null;
  const d = trimmed.toLowerCase();
  if (d === 'overview' || d === 'easy' || d === 'beginner') {
    return m.import_depth_badge_overview();
  }
  if (d === 'deep' || d === 'hard') {
    return m.import_depth_badge_deep();
  }
  if (d === 'standard' || d === 'default') {
    return m.import_depth_badge_standard();
  }
  return trimmed;
}

/** URL 追加讲法参数（外链跳过；已有查询串用 & 拼接） */
function appendEditionParam(url: string, edition: string): string {
  if (!edition || !url || url.startsWith('http')) return url;
  return url.includes('?') ? `${url}&edition=${encodeURIComponent(edition)}` : `${url}?edition=${encodeURIComponent(edition)}`;
}

/** 深度优先收集 fumadocs PageTree 页面 url（folder.root 优先于 children，保持教学序） */
function collectTreePageUrls(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectTreePageUrls(n, acc);
    return acc;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.url === 'string') acc.push(rec.url);
  if (rec.index) collectTreePageUrls(rec.index, acc);
  if (rec.root) collectTreePageUrls(rec.root, acc);
  if (Array.isArray(rec.children)) collectTreePageUrls(rec.children, acc);
  return acc;
}

function normalizeEditionSlug(u: string): string {
  let decoded = u;
  try {
    decoded = decodeURIComponent(u);
  } catch {}
  return decoded.trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\.(md|mdx)$/i, '');
}

/**
 * 讲法切换直链解析（跨讲法 404 根因修复）：
 * - 当前 slug 在目标讲法树中存在 → 沿用当前路径（保留读者位置），仅切换 ?edition=；
 * - 不存在 → 直链目标讲法教学序首章，杜绝「拿 A 讲法的 slug 访问 B 讲法」的结构性 404；
 * - 目标讲法树未构建（editionTrees 缺键）→ 退回旧行为（当前路径 + 参数），
 *   服务端 docs-page-loader 的精确匹配兜底仍在线。
 */
export function resolveEditionHref(params: {
  targetEdition: string;
  isDefault: boolean;
  pathname: string;
  owner: string;
  repo: string;
  tree: unknown;
}): string {
  const { targetEdition, isDefault, pathname, owner, repo, tree } = params;
  const fallback = isDefault
    ? pathname
    : appendEditionParam(pathname, targetEdition);

  const urls = collectTreePageUrls(tree);
  if (urls.length === 0) return fallback;

  const prefix = `/docs/${owner}/${repo}`.toLowerCase();
  const suffixOf = (u: string): string | null => {
    let decoded = u;
    try {
      decoded = decodeURIComponent(u);
    } catch {}
    return decoded.toLowerCase().startsWith(prefix)
      ? normalizeEditionSlug(decoded.slice(prefix.length))
      : null;
  };

  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {}

  const currentSlug = decodedPathname.toLowerCase().startsWith(prefix)
    ? normalizeEditionSlug(decodedPathname.slice(prefix.length))
    : null;

  if (currentSlug !== null) {
    // 根路径与 readme/index 语义等价（与侧栏激活判定同口径）
    const rootish = (s: string) => s === '' || s === 'readme' || s === 'index';
    const exists = urls.some((u) => {
      const s = suffixOf(u);
      return s !== null && (s === currentSlug || (rootish(s) && rootish(currentSlug)));
    });
    if (exists) return fallback;
  }

  // 当前 slug 不属于目标讲法拓扑：直链目标讲法教学序首章
  const first = urls.map((u) => ({ u, s: suffixOf(u) })).find((x) => x.s !== null);
  const firstUrl = first?.u ?? urls[0];
  return isDefault ? firstUrl : appendEditionParam(firstUrl, targetEdition);
}

/** 递归改写 fumadocs PageTree 节点的内部链接（folder.children / folder.root / page.url） */
function rewriteTreeUrls(node: unknown, edition: string): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => rewriteTreeUrls(n, edition));
  const copy: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  if (typeof copy.url === 'string') {
    copy.url = appendEditionParam(copy.url, edition);
  }
  if (copy.index) {
    copy.index = rewriteTreeUrls(copy.index, edition);
  }
  if (Array.isArray(copy.children)) {
    copy.children = rewriteTreeUrls(copy.children, edition);
  }
  if (copy.root) {
    copy.root = rewriteTreeUrls(copy.root, edition);
  }
  return copy;
}

interface EditionAwareDocsLayoutProps extends React.ComponentProps<typeof DocsLayout> {
  editionTrees?: Record<string, any>;
}

function DocsLayoutInner(props: EditionAwareDocsLayoutProps) {
  const { editionTrees, ...layoutProps } = props;
  const searchParams = useSearchParams();
  const edition = searchParams.get('edition') ?? '';
  const currentTree = (editionTrees && editionTrees[edition]) || layoutProps.tree;
  const tree = useMemo(
    () => (edition ? rewriteTreeUrls(currentTree, edition) : currentTree),
    [currentTree, edition]
  );
  return <DocsLayout {...layoutProps} tree={tree} />;
}

/** DocsLayout 包装：sidebar 树 URL 讲法感知（Suspense 供 useSearchParams 静态渲染兜底） */
export function EditionAwareDocsLayout(props: EditionAwareDocsLayoutProps) {
  const { editionTrees: _, ...fallbackProps } = props;
  return (
    <Suspense fallback={<DocsLayout {...fallbackProps} />}>
      <DocsLayoutInner {...props} />
    </Suspense>
  );
}

function SwitcherInner({
  editions,
  owner,
  repo,
  editionTrees,
}: {
  editions: RepositoryEditionOption[];
  owner: string;
  repo: string;
  editionTrees?: Record<string, any>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentEdition = searchParams.get('edition') ?? '';
  const [open, setOpen] = useState(false);

  const activeOption =
    editions.find((e) => e.edition === currentEdition) ||
    editions.find((e) => e.isDefault) ||
    editions[0];

  return (
    <div className="flex items-center shrink-0 my-auto mr-1 ml-auto md:ml-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'relative inline-flex items-center justify-center size-7 rounded-lg border border-theme-border/70 bg-theme-bg/80 text-theme-muted hover:text-theme-foreground hover:bg-theme-surface hover:border-theme-border transition-colors cursor-pointer',
            open && 'bg-theme-surface text-theme-primary border-theme-primary/40 shadow-xs'
          )}
          aria-label={`${m.edition_section_title()} · ${activeOption?.label || ''}`}
          title={`${m.edition_section_title()} · ${activeOption?.label || ''}`}
        >
          <Layers className="size-3.5" />
          <span className="sr-only">{m.edition_section_title()}</span>
          {editions.length > 1 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-theme-primary text-micro font-mono font-bold text-theme-primary-fg leading-none shadow-xs">
              {editions.length}
            </span>
          )}
        </PopoverTrigger>

        <PopoverPopup
          side="bottom"
          align="end"
          sideOffset={6}
          viewportClassName="p-0"
          className="w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-theme-bg border border-theme-border/80 shadow-2xl p-0 overflow-hidden text-left z-[100] focus:outline-none"
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-theme-border/60 bg-theme-surface/40 shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <Layers className="size-3.5 text-theme-primary shrink-0" />
              <span className="text-xs font-serif font-bold text-theme-foreground">
                {m.edition_section_title()}
              </span>
              <span className="text-micro font-mono px-1.5 py-0.5 rounded-full bg-theme-primary/10 text-theme-primary font-medium shrink-0">
                {editions.length}
              </span>
            </div>
            <span className="text-micro text-theme-muted font-sans truncate max-w-28 text-right">
              {activeOption?.label}
            </span>
          </div>

          <div className="p-1.5 space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
            {editions.map((ed) => {
              const { Icon, toneClass } = editionVisual(ed.presetId);
              const preset = ed.presetId ? resolveTranscriptionPreset(ed.presetId) : null;
              const isActive = ed.edition === currentEdition;
              const depthLabel = resolveTeachingDepthLabel(ed.teachingDepth);
              // 直链解析：当前 slug 不在目标讲法拓扑时链向其教学序首章（跨讲法 404 根因修复）
              const href = resolveEditionHref({
                targetEdition: ed.edition,
                isDefault: ed.isDefault,
                pathname,
                owner,
                repo,
                tree: editionTrees?.[ed.edition],
              });

              const metaParts: string[] = [];
              if (ed.creatorName?.trim() && !ed.isCurrentUserCreator) {
                metaParts.push(ed.creatorName.trim());
              }
              const timeStr = formatEditionRelativeTime(ed.updatedAt || ed.createdAt);
              if (timeStr) metaParts.push(timeStr);
              if (typeof ed.chapterCount === 'number' && ed.chapterCount > 0) {
                metaParts.push(formatChapterCount(ed.chapterCount));
              }
              if (typeof ed.wordCount === 'number' && ed.wordCount > 0) {
                const wordsStr = formatWordCount(ed.wordCount);
                if (wordsStr) metaParts.push(wordsStr);
              }

              return (
                <Link
                  key={ed.id}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-start gap-2.5 p-2 rounded-lg transition-all group cursor-pointer',
                    isActive
                      ? 'bg-theme-primary/10 border border-theme-primary/30'
                      : 'hover:bg-theme-surface border border-transparent'
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex items-center justify-center size-6 rounded-md border shrink-0 mt-0.5',
                      toneClass
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    {/* Row 1: Edition label/name + Badges + Checkmark */}
                    <div className="flex items-center justify-between gap-1.5 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span
                          className={cn(
                            'text-xs font-serif font-bold truncate',
                            isActive ? 'text-theme-primary' : 'text-theme-foreground group-hover:text-theme-primary'
                          )}
                        >
                          {ed.label}
                        </span>
                        {ed.isCurrentUserCreator && (
                          /* lint-ignore: FONT-001 */
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shrink-0 leading-none">
                            {m.version_tag_mine()}
                          </span>
                        )}
                        {depthLabel && (
                          /* lint-ignore: FONT-001 */
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-theme-surface text-theme-muted border border-theme-border/70 shrink-0 leading-none">
                            {depthLabel}
                          </span>
                        )}
                      </div>
                      {isActive && (
                        <Check className="size-3.5 text-theme-primary shrink-0 ml-auto" />
                      )}
                    </div>

                    {/* Row 2: Preset description (if available) */}
                    {preset?.description ? (
                      <p className="text-micro text-theme-muted font-sans leading-snug line-clamp-1 mt-0.5">
                        {preset.description}
                      </p>
                    ) : null}

                    {/* Row 3: Meta footer */}
                    {metaParts.length > 0 && (
                      <p
                        /* lint-ignore: FONT-001 */
                        className="text-[11px] text-theme-muted/80 font-sans leading-normal truncate mt-1"
                        title={metaParts.join(' · ')}
                      >
                        {metaParts.join(' · ')}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="p-2 border-t border-theme-border/60 bg-theme-surface/20 shrink-0">
            <a
              href={`/?import=${encodeURIComponent(`${owner}/${repo}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1.5 w-full py-1.5 px-2 rounded-lg border border-dashed border-theme-border hover:border-theme-primary/50 bg-theme-bg hover:bg-theme-primary/5 text-theme-muted hover:text-theme-primary text-xs font-serif transition-all cursor-pointer"
            >
              <span className="text-sm leading-none font-bold">＋</span>
              <span>{m.edition_chips_custom_create()}</span>
              <ExternalLink className="size-2.5 opacity-60 ml-0.5" />
            </a>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/** 讲法切换器：editions ≤1 时调用方不渲染（单讲法零 UI 变化；当 store 监听到新版本加入时即时渲染） */
export function DocsEditionSwitcher({
  editions,
  owner,
  repo,
  editionTrees,
}: {
  editions: RepositoryEditionOption[];
  owner: string;
  repo: string;
  editionTrees?: Record<string, any>;
}) {
  const storeEditions = useIngestQueueStore((s) => s.availableEditions);
  const effectiveEditions =
    storeEditions && storeEditions.length > editions.length ? storeEditions : editions;

  if (!effectiveEditions || effectiveEditions.length <= 1) return null;
  return (
    <Suspense fallback={null}>
      <SwitcherInner editions={effectiveEditions} owner={owner} repo={repo} editionTrees={editionTrees} />
    </Suspense>
  );
}

/**
 * 讲法模型归属徽章（客户端根据当前 URL ?edition= 动态解析模型并显示）
 */
function ModelBadgeInner({
  editions,
  fallbackModels,
}: {
  editions: RepositoryEditionOption[];
  fallbackModels: string[];
}) {
  const searchParams = useSearchParams();
  const currentEdition = searchParams.get('edition') ?? '';
  const storeEditions = useIngestQueueStore((s) => s.availableEditions);
  const effectiveEditions =
    storeEditions && storeEditions.length > editions.length ? storeEditions : editions;
  const activeOption =
    effectiveEditions.find((e) => e.edition === currentEdition) ||
    effectiveEditions.find((e) => e.isDefault) ||
    effectiveEditions[0];
  // 跨讲法防污染守卫：仅当处于主讲法（edition=''）时，允许回退至主讲法的 fallbackModels；
  // 若当前访问的是非默认的衍生新讲法（如 ed_xxxx），在转录初期章节尚未落库前，
  // 严禁误回退至旧版本/默认版本的历史模型，杜绝张冠李戴。
  const isCurrentDefault = !currentEdition || Boolean(activeOption?.isDefault);
  const models =
    activeOption?.transcriptionModels && activeOption.transcriptionModels.length > 0
      ? activeOption.transcriptionModels
      : isCurrentDefault
      ? fallbackModels
      : [];

  if (!models || models.length === 0) return null;

  return (
    <p
      className="px-2 text-micro text-theme-muted font-mono truncate"
      title={m.dashboard_transcription_models({ models: models.join(', ') })}
    >
      {m.reader_model_provided_by({ model: models.join(', ') })}
    </p>
  );
}

export function DocsEditionModelBadge({
  editions,
  fallbackModels,
}: {
  editions: RepositoryEditionOption[];
  fallbackModels: string[];
}) {
  return (
    <Suspense
      fallback={
        fallbackModels.length > 0 ? (
          <p
            className="px-2 text-micro text-theme-muted font-mono truncate"
            title={m.dashboard_transcription_models({ models: fallbackModels.join(', ') })}
          >
            {m.reader_model_provided_by({ model: fallbackModels.join(', ') })}
          </p>
        ) : null
      }
    >
      <ModelBadgeInner editions={editions} fallbackModels={fallbackModels} />
    </Suspense>
  );
}
