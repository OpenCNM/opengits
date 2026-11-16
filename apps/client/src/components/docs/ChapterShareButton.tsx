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

/**
 * 嗅探当前视口内阅读中的激活标题锚点（基于真实可见度）：
 * 当读者未手动点击 TOC / # 锚点时，自动感知当前正读到的小节并附加对应 ID。
 */
export function detectActiveHeadingAnchor(root?: Document | HTMLElement): string | null {
  if (typeof window === 'undefined') return null;

  // 1. 若浏览器当前 URL 已有明确锚点，优先尊重
  if (window.location.hash) {
    const clean = window.location.hash.replace(/^#/, '');
    if (clean) return clean;
  }

  // 2. 页面在顶部未发生实质滚动（< 140px）时，保留纯净章节根 URL
  const scrollY = window.scrollY || document.documentElement.scrollTop;
  if (scrollY < 140) {
    return null;
  }

  // 3. 扫描正文区域内所有具有物理 ID 的标题
  const docRoot = root || document.getElementById('doc-content-area') || document.querySelector('article') || document.querySelector('main');
  if (!docRoot) return null;

  const headings = Array.from(docRoot.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')) as HTMLElement[];
  if (headings.length === 0) return null;

  // 视口感知阈值：寻找顶部位置在阅读基准线（顶栏高度 + 余裕）以上的最后一个标题
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

/**
 * 极简章节与锚点分享按钮：
 * 1-Click 复制当前直达 URL（支持视口激活 #anchor 动态嗅探），接收方打开浏览器原生滚到对应位置。
 */
export function ChapterShareButton({ title, className = '', isPublic = true }: ChapterShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = useCallback(async () => {
    if (typeof window === 'undefined') return;

    let targetUrl = window.location.href;
    const activeAnchor = detectActiveHeadingAnchor();

    // 动态附着锚点并静默同步地址栏（给分享者直观的视觉确认）
    if (activeAnchor && !window.location.hash) {
      try {
        const urlObj = new URL(targetUrl);
        urlObj.hash = activeAnchor;
        targetUrl = urlObj.toString();
        window.history.replaceState(window.history.state, '', targetUrl);
      } catch {
        // ignore URL parse errors
      }
    }

    // 移动端优先唤起原生系统分享（若受支持且非桌面端）
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    if (isMobile && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: title || document.title,
          url: targetUrl,
        });
        return;
      } catch (err: any) {
        // 用户取消分享或系统拒绝时，平滑降级到剪贴板复制
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

      // 若为私有教程，给予前置风险告知；公开教程给予正常直达提示
      if (!isPublic) {
        toastManager.add({
          type: 'warning',
          title: m.doc_share_private_title(),
          description: m.doc_share_private_desc(),
        });
      } else {
        toastManager.add({
          type: 'success',
          title: m.doc_share_copied_title(),
          description: m.doc_share_copied_desc(),
        });
      }

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      toastManager.add({
        type: 'error',
        title: m.toast_action_failed(),
      });
    }
  }, [title, isPublic]);

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
