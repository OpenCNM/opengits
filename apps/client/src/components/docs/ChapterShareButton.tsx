'use client';

import React, { useState, useCallback } from 'react';
import { Share2, Check } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { toastManager } from '@/components/ui/toast';

export interface ChapterShareButtonProps {
  title?: string | null;
  className?: string;
  isPublic?: boolean;
}

export function detectActiveHeadingAnchor(root?: Document | HTMLElement): string | null {
  if (typeof window === 'undefined') return null;

  if (window.location.hash) {
    const clean = window.location.hash.replace(/^#/, '');
    if (clean) return clean;
  }

  const scrollY = window.scrollY || document.documentElement.scrollTop;
  if (scrollY < 140) {
    return null;
  }

  const docRoot = root || document.getElementById('doc-content-area') || document.querySelector('article') || document.querySelector('main');
  if (!docRoot) return null;

  const headings = Array.from(docRoot.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')) as HTMLElement[];
  if (headings.length === 0) return null;

  const readingLine = 160;
  let activeHeading: HTMLElement | null = null;

  for (const h of headings) {
    const rect = h.getBoundingClientRect();
    if (rect.top <= readingLine) {
      activeHeading = h;
    } else {
      break;
    }
  }

  return activeHeading?.id || null;
}

export function ChapterShareButton({ title, className = '', isPublic = true }: ChapterShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = useCallback(async () => {
    if (typeof window === 'undefined') return;

    let targetUrl = window.location.href;
    const activeAnchor = detectActiveHeadingAnchor();

    if (activeAnchor && !window.location.hash) {
      try {
        const urlObj = new URL(targetUrl);
        urlObj.hash = activeAnchor;
        targetUrl = urlObj.toString();
        window.history.replaceState(window.history.state, '', targetUrl);
      } catch {
      }
    }

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    if (isMobile && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: title || document.title,
          url: targetUrl,
        });
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
      }
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(targetUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = targetUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      setCopied(true);

      toastManager.add({
        type: 'success',
        title: m.doc_share_copied_title(),
        description: m.doc_share_copied_desc(),
      });

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      toastManager.add({
        type: 'error',
        title: m.toast_action_failed(),
      });
    }
  }, [title]);

  if (!isPublic) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      title={m.doc_share_tooltip()}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-theme-muted hover:text-theme-foreground bg-theme-surface/60 hover:bg-theme-surface border border-theme-border/60 hover:border-theme-border rounded-lg transition-all duration-150 cursor-pointer shrink-0 select-none ${className}`}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-theme-primary transition-transform scale-110" />
      ) : (
        <Share2 className="w-3.5 h-3.5 text-theme-muted" />
      )}
      <span>{copied ? m.common_copied() : m.doc_share_button()}</span>
    </button>
  );
}
