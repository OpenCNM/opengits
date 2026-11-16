'use client';

import React from 'react';
import Link from 'next/link';
import { Bookmark, Sparkles } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { ChapterShareButton } from './ChapterShareButton';

export interface GuestShelfJoinCalloutProps {
  title?: string | null;
  owner: string;
  repo: string;
  isPublic?: boolean;
}

/**
 * 访客阅读承接卡片（社交分享转化闭环）：
 * 当外部受众通过分享链接直达公开教程且未登录时，在正文末尾呈现温和引导，
 * 支持一键登录入架与原地快捷二次分享。
 */
export function GuestShelfJoinCallout({
  title,
  owner,
  repo,
  isPublic = true,
}: GuestShelfJoinCalloutProps) {
  const signinUrl = `/auth/signin?callbackUrl=${encodeURIComponent(
    typeof window !== 'undefined' ? window.location.pathname : `/docs/${owner}/${repo}`
  )}`;

  return (
    <div className="mt-10 p-5 rounded-2xl border border-theme-border/80 bg-theme-surface/50 backdrop-blur-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-theme-primary/10 border border-theme-primary/20 flex items-center justify-center shrink-0 mt-0.5 text-theme-primary">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-theme-foreground">
            {m.doc_guest_callout_title()}
          </h4>
          <p className="text-xs text-theme-muted mt-0.5 leading-relaxed">
            {m.doc_guest_callout_desc()}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
        <ChapterShareButton title={title} isPublic={isPublic} />
        <Link
          href={signinUrl}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-theme-bg bg-theme-foreground hover:opacity-90 rounded-lg transition-opacity cursor-pointer shadow-sm select-none"
        >
          <Bookmark className="w-3.5 h-3.5" />
          <span>{m.doc_guest_callout_btn()}</span>
        </Link>
      </div>
    </div>
  );
}
