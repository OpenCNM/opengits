'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as m from '@/paraglide/messages';
import { GENERATION_LEVEL } from '@/lib/constants';

interface ChapterDegradedNoticeProps {
  documentId: string;
  generationLevel?: string | null;
  targetLanguage?: string | null;
  className?: string;
}

/**
 * 结构化原文保全与一键重翻提示胶囊（读者知情与第一性原理自愈闭环）：
 * 仅在：
 * 1. 目标语言已设定（用户期望中文等目标语言，targetLanguage 非空且非 'none'）；
 * 2. 当前章节内容等级为 ORIGINAL（翻译未完成，保全展示结构化原文）；
 * 时渲染，为读者提供透明感知与一键 JIT 重新翻译触发入口。
 */
export function ChapterDegradedNotice({
  documentId,
  generationLevel,
  targetLanguage,
  className = '',
}: ChapterDegradedNoticeProps) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (generationLevel !== GENERATION_LEVEL.ORIGINAL) {
    return null;
  }
  if (!targetLanguage || targetLanguage === 'none' || targetLanguage === 'original') {
    return null;
  }

  const handleRetranslate = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setErrorMsg(null);

    try {
      // 步骤 1：重置文档状态到 UNPROCESSED (force=true 保证安全接管)
      const resetRes = await fetch(`/api/documents/${documentId}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!resetRes.ok) {
        throw new Error('Reset failed');
      }

      // 步骤 2：以 JIT 高优先级抢占入队
      await fetch(`/api/documents/${documentId}/prioritize`, {
        method: 'POST',
      });

      // 步骤 3：刷新页面进入转录进度视图
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
