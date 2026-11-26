'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as m from '@/paraglide/messages';
import { GENERATION_LEVEL } from '@/lib/constants';

interface ChapterDegradedNoticeProps {
  documentId: string;
  generationLevel?: string | null;
  targetLanguage?: string | null;
  docPath?: string | null;
  className?: string;
}

const MARKDOWN_DOC_EXT_RE = /\.(md|mdx|markdown)$/i;

export function shouldShowChapterDegradedNotice({
  generationLevel,
  targetLanguage,
  docPath,
}: {
  generationLevel?: string | null;
  targetLanguage?: string | null;
  docPath?: string | null;
}): boolean {
  if (generationLevel !== GENERATION_LEVEL.ORIGINAL) {
    return false;
  }
  if (!targetLanguage || targetLanguage === 'none' || targetLanguage === 'original') {
    return false;
  }
  if (docPath) {
    const cleanPath = docPath.split('#')[0].trim();
    if (cleanPath && !MARKDOWN_DOC_EXT_RE.test(cleanPath)) {
      return false;
    }
  }
  return true;
}

export function ChapterDegradedNotice({
  documentId,
  generationLevel,
  targetLanguage,
  docPath,
  className = '',
}: ChapterDegradedNoticeProps) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!shouldShowChapterDegradedNotice({ generationLevel, targetLanguage, docPath })) {
    return null;
  }

  const handleRetranslate = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setErrorMsg(null);

    try {
      const resetRes = await fetch(`/api/documents/${documentId}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!resetRes.ok) {
        throw new Error('Reset failed');
      }

      await fetch(`/api/documents/${documentId}/prioritize`, {
        method: 'POST',
      });

      router.refresh();
    } catch (err: any) {
      console.warn('[ChapterDegradedNotice] Retranslate failed:', err);
      setErrorMsg(m.chapter_retranslate_failed());
      setIsRetrying(false);
    }
  };

  return (
    <div
      className={`flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs mb-4 select-none ${className}`}
      data-testid="chapter-degraded-notice"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <svg
          className="w-4 h-4 shrink-0 text-amber-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <span className="truncate font-sans">
          {errorMsg || m.chapter_original_untranslated_notice()}
        </span>
      </div>
      <button
        type="button"
        onClick={handleRetranslate}
        disabled={isRetrying}
        className="px-2.5 py-1 text-micro font-medium rounded-lg bg-amber-500 hover:bg-amber-600 text-white shrink-0 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
      >
        {isRetrying ? m.chapter_retranslating() : m.chapter_retranslate_button()}
      </button>
    </div>
  );
}
