'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Clock, Loader2, Zap, AlertTriangle } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import { useShallow } from 'zustand/react/shallow';
import {
  useIngestQueueStore,
  normalizeDocPath,
  getNormalizedDocMap,
  selectTranscriptionProjection,
} from '@/lib/stores/ingest-queue-store';
import { docPathToSlug } from '@/lib/outline-reader';
import { toastManager } from '@/components/ui/toast';
import { DocumentStatus } from '@/lib/constants';
import { parseChapterTitle } from '@/lib/chapter-title';
import { projectChapterLifecycleState } from '@/lib/state/curriculum-state-projector';
import { isNativeWebDocMirror } from '@/lib/repository-origin';

export type { ParsedChapterTitle } from '@/lib/chapter-title';
export { parseChapterTitle } from '@/lib/chapter-title';

interface SidebarProgressItemProps {
  docPath?: string;
  title: string;
  isHot?: boolean;
  owner?: string;
  repo?: string;
  url?: string;
  isWebDoc?: boolean;
}

function checkIsItemActive(pathname: string | null, url?: string, owner?: string, repo?: string, docPath?: string): boolean {
  if (!pathname) return false;
  let cleanPath: string;
  try {
    cleanPath = decodeURIComponent(pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    cleanPath = pathname.replace(/\/+$/, '').toLowerCase();
  }

  if (url) {
    let cleanTarget: string;
    try {
      cleanTarget = decodeURIComponent(url.split('?')[0].split('#')[0]).replace(/\/+$/, '').toLowerCase();
    } catch {
      cleanTarget = url.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
    }
    if (cleanPath === cleanTarget) return true;
  }

  if (owner && repo) {
    const repoPrefix = `/docs/${owner.toLowerCase()}/${repo.toLowerCase()}`;
    if (!cleanPath.startsWith(repoPrefix)) return false;
    const currentSlug = cleanPath.slice(repoPrefix.length).replace(/^\/+/, '');

    if (!docPath) {
      return currentSlug === '';
    }

    let targetSlug = docPathToSlug(normalizeDocPath(docPath)).toLowerCase();
    if (targetSlug === 'readme' || targetSlug === 'index') {
      targetSlug = '';
    } else if (targetSlug.endsWith('/readme') || targetSlug.endsWith('/index')) {
      targetSlug = targetSlug.slice(0, targetSlug.lastIndexOf('/'));
    }
    return currentSlug === targetSlug || currentSlug === docPath.toLowerCase().replace(/^\/+|\/+$/g, '');
  }

  return false;
}

export function SidebarProgressItem({ docPath, title, isHot, owner, repo, url, isWebDoc }: SidebarProgressItemProps) {
  const [mounted, setMounted] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPrioritizing, setIsPrioritizing] = useState(false);
  const pathname = usePathname();
  const itemRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const prioritize = useIngestQueueStore((state) => state.prioritize);
  const regenerate = useIngestQueueStore((state) => state.regenerate);

  const searchParams = useSearchParams();
  const currentEdition = searchParams?.get('edition') ?? '';

  const repoKey = owner && repo
    ? currentEdition
      ? `${owner}/${repo}:${currentEdition}`
      : `${owner}/${repo}`
    : undefined;
  const score = useReadingProgressStore((state) => (docPath ? state.getChapterScore(docPath, repoKey) : 0));
  const displayScore = mounted ? score : 0;

  const docItem = useIngestQueueStore(
    useShallow((state) => {
      if (!docPath) return null;
      if (owner && repo && state.owner && state.repo && (state.owner !== owner || state.repo !== repo)) {
        return null;
      }
      if (state.edition !== currentEdition) {
        return null;
      }
      const docMap = getNormalizedDocMap(state.documents);
      const doc = docMap.get(docPath) ?? docMap.get(normalizeDocPath(docPath)) ?? null;
      if (!doc) return null;

      const lifecycleState = projectChapterLifecycleState(doc, {
        prioritizedId: state.prioritizedId,
        currentProcessingId: state.currentProcessingId,
        processingDocIds: state.processingDocIds,
      });

      let isNext = false;
      if (lifecycleState === 'QUEUED') {
        const proj = selectTranscriptionProjection(state);
        isNext = proj.nextChapter?.id === doc.id;
      }

      return {
        id: doc.id,
        status: doc.status,
        lifecycleState,
        isNext,
        isVirtual: doc.isVirtual ?? false,
        queuePosition: doc.transcriptionJob?.queuePosition ?? null,
      };
    })
  );

  const { index, cleanTitle } = parseChapterTitle(title);
  const fullDisplayTitle = cleanTitle;

  const isPendingTranscription = Boolean(
    docItem &&
    (docItem.lifecycleState === 'QUEUED' ||
     docItem.lifecycleState === 'PRIORITIZED' ||
     docItem.lifecycleState === 'RUNNING' ||
     docItem.lifecycleState === 'FAILED')
  );
  const isNativeMirror = isWebDoc
    ? !currentEdition.trim()
    : isNativeWebDocMirror({ owner, repo, edition: currentEdition });
  const showReadingScore = !isNativeMirror && displayScore > 0 && !isPendingTranscription;

  const isActive = useMemo(
    () => checkIsItemActive(pathname, url, owner, repo, docPath),
    [pathname, url, owner, repo, docPath]
  );

  useEffect(() => {
    if (!itemRef.current) return;
    const parentLink = itemRef.current.closest('a');
    if (parentLink) {
      if (isActive) {
        parentLink.setAttribute('data-active', 'true');
      } else {
        const linkHref = parentLink.getAttribute('href');
        if (linkHref) {
          const cleanHref = linkHref.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
          let cleanCurrentPath: string;
          try {
            cleanCurrentPath = decodeURIComponent(pathname || '').replace(/\/+$/, '').toLowerCase();
          } catch {
            cleanCurrentPath = (pathname || '').replace(/\/+$/, '').toLowerCase();
          }
          if (cleanHref !== cleanCurrentPath) {
            parentLink.removeAttribute('data-active');
          }
        }
      }
    }
  }, [isActive, pathname]);

  useEffect(() => {
    if (isActive && itemRef.current) {
      itemRef.current.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  return (
    <span
      ref={itemRef}
      data-chapter-active={isActive ? 'true' : undefined}
      className={`relative flex items-center justify-between w-full min-w-0 pr-1 group/sidebar-item sidebar-chapter-item ${
        isActive ? 'sidebar-chapter-active' : ''
      }`}
      title={title}
    >
      <span className="flex items-center min-w-0 flex-1">
        {mounted && docItem?.lifecycleState === 'RUNNING' && (
          <span className="mr-1.5 shrink-0 inline-flex items-center" aria-label="Processing" title={m.status_processing()}>
            <Loader2 size={12} className="animate-spin text-theme-primary" />
          </span>
        )}
        {mounted && docItem?.lifecycleState === 'PRIORITIZED' && (
          <span
            className="mr-1.5 shrink-0 inline-flex items-center text-amber-500 font-bold text-xs"
            aria-label="Prioritized"
            title={m.sidebar_prioritized_badge()}
          >
            <Zap size={11} className="fill-amber-500/20 text-amber-500" />
          </span>
        )}
        {mounted && docItem?.lifecycleState === 'QUEUED' && docItem.isNext && (
          <span
            title={
              m.ingest_capsule_next_label() +
              (docItem.queuePosition ? ` · ${m.ingest_queue_position_badge({ position: docItem.queuePosition })}` : '')
            }
            className="mr-1.5 shrink-0 inline-flex items-center text-theme-primary"
            aria-label="Next"
          >
            <Clock size={11} className="animate-pulse" />
          </span>
        )}
        {mounted && docItem?.lifecycleState === 'QUEUED' && !docItem.isNext && (
          <span
            title={
              docItem.queuePosition
                ? `${m.status_queued()} · ${m.ingest_queue_position_badge({ position: docItem.queuePosition })}`
                : m.status_queued()
            }
            className="mr-1.5 shrink-0 inline-flex items-center text-theme-muted/50 group-hover/sidebar-item:text-theme-muted transition-colors"
            aria-label="Queued"
          >
            <Clock size={11} />
          </span>
        )}
        {mounted && docItem?.lifecycleState === 'FAILED' && (
          <span className="mr-1.5 shrink-0 inline-flex items-center text-theme-accent" aria-label="Error" title={m.status_failed()}>
            <AlertTriangle size={11} />
          </span>
        )}
        {index && (
          <span
            className={`sidebar-chapter-index font-mono text-xs select-none shrink-0 w-[18px] text-left transition-colors ${
              isActive
                ? 'text-theme-primary font-bold'
                : 'text-theme-muted/60 group-hover/sidebar-item:text-theme-foreground'
            }`}
          >
            {index}
          </span>
        )}
        <span
          className={`sidebar-chapter-title truncate ${index ? 'ml-1.5' : ''} ${
            isActive ? 'font-semibold text-theme-foreground' : ''
          }`}
        >
          {fullDisplayTitle}
        </span>
      </span>

      {showReadingScore && (
        <span
          className={`sidebar-chapter-score text-xs font-mono font-normal ml-2 shrink-0 select-none transition-all duration-300 ${
            isActive
              ? 'text-theme-primary font-medium'
              : 'text-theme-muted/60 group-hover/sidebar-item:text-theme-muted'
          }`}
        >
          {displayScore}%
        </span>
      )}

      {mounted && docItem && docItem.lifecycleState !== 'READY' && (
        <>
          {docItem.lifecycleState === 'PRIORITIZED' && (
            <span className="ml-1 shrink-0 text-micro font-bold px-1.5 py-0.5 rounded bg-theme-primary/15 text-theme-primary select-none">
              {m.sidebar_prioritized_badge()}
            </span>
          )}
          {docItem.lifecycleState === 'QUEUED' && !docItem.isVirtual && (
            <button
              type="button"
              disabled={isPrioritizing}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isPrioritizing) return;
                setIsPrioritizing(true);
                try {
                  const accepted = await prioritize(docItem.id);
                  if (!accepted) {
                    toastManager.add({ type: 'error', title: m.toast_action_failed() });
                  }
                } finally {
                  setIsPrioritizing(false);
                }
              }}
              className={`absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/sidebar-item:opacity-100 pointer-events-none group-hover/sidebar-item:pointer-events-auto transition-opacity px-1.5 py-0.5 text-micro rounded bg-theme-surface border border-theme-border/60 text-theme-primary hover:bg-theme-primary hover:text-theme-primary-fg shrink-0 cursor-pointer font-medium select-none shadow-xs z-10 ${
                isPrioritizing ? 'pointer-events-none opacity-50' : ''
              }`}
              title={m.sidebar_prioritize_action()}
            >
              {isPrioritizing ? (
                <Loader2 size={10} className="animate-spin inline-block" />
              ) : (
                m.sidebar_prioritize_action()
              )}
            </button>
          )}
          {docItem.lifecycleState === 'FAILED' && (
            <button
              type="button"
              disabled={isRetrying}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isRetrying) return;
                setIsRetrying(true);
                try {
                  await regenerate(docItem.id);
                } finally {
                  setIsRetrying(false);
                }
              }}
              className={`absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/sidebar-item:opacity-100 pointer-events-none group-hover/sidebar-item:pointer-events-auto transition-opacity px-1.5 py-0.5 text-micro rounded bg-theme-surface border border-theme-border/60 text-theme-accent hover:bg-theme-accent hover:text-white shrink-0 cursor-pointer font-medium select-none shadow-xs z-10 ${
                isRetrying ? 'pointer-events-none opacity-50' : ''
              }`}
              title={m.ingest_regenerate_chapter()}
            >
              {isRetrying ? (
                <Loader2 size={10} className="animate-spin inline-block" />
              ) : (
                m.ingest_regenerate()
              )}
            </button>
          )}
        </>
      )}
    </span>
  );
}
