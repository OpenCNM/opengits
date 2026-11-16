'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useEffect } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { UpdatePlanDialog } from './UpdatePlanDialog';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { STORAGE_KEYS } from '@/lib/constants';

export interface UpstreamUpdateToastProps {
  owner: string;
  repo: string;
  hasUpstreamUpdate?: boolean;
}

// 72 小时（3 天）温和冷却唤醒周期
const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
// 同一版本最大主动关闭次数（达到后深度静音，直至上游推送新 Commit）
const MAX_DISMISS_COUNT = 2;

export function UpstreamUpdateToast({ owner, repo, hasUpstreamUpdate }: UpstreamUpdateToastProps) {
  const [visible, setVisible] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    if (!hasUpstreamUpdate) {
      setVisible(false);
      return;
    }

    // 1. 会话级静音检查（同一浏览器标签页/会话内关闭过，本次阅读绝对不再重复打扰）
    try {
      const sessionDismissed = sessionStorage.getItem(`update_toast_dismissed_${owner}_${repo}`);
      if (sessionDismissed === '1') {
        setVisible(false);
        return;
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }

    // 2. 版本与时间衰减策略检查（LocalStorage）
    let shouldShow = true;
    try {
      const rawPref = localStorage.getItem(STORAGE_KEYS.UPDATE_TOAST_PREF(owner, repo));
      if (rawPref) {
        const pref = JSON.parse(rawPref) as { dismissedAt?: number; dismissCount?: number };
        const now = Date.now();
        const isWithinCooldown = now - (pref.dismissedAt || 0) < COOLDOWN_MS;
        const isMaxDismissed = (pref.dismissCount || 0) >= MAX_DISMISS_COUNT;

        if (isWithinCooldown || isMaxDismissed) {
          shouldShow = false;
        }
      }
    } catch {
      // Fallback to show
    }

    if (shouldShow) {
      setVisible(true);
      // 埋点 1：曝光展示
      trackEvent({
        eventType: TELEMETRY_EVENTS.UPSTREAM_TOAST_IMPRESSION,
        metadata: { owner, repo },
      });
    }
  }, [owner, repo, hasUpstreamUpdate]);

  const handleDismiss = () => {
    setVisible(false);

    // 写入会话级静音
    try {
      sessionStorage.setItem(`update_toast_dismissed_${owner}_${repo}`, '1');
    } catch {}

    // 写入跨会话持久化与关闭计数
    let newCount = 1;
    try {
      const prefKey = STORAGE_KEYS.UPDATE_TOAST_PREF(owner, repo);
      const rawPref = localStorage.getItem(prefKey);
      const prevPref = rawPref ? JSON.parse(rawPref) : {};
      newCount = (prevPref.dismissCount || 0) + 1;
      localStorage.setItem(
        prefKey,
        JSON.stringify({
          dismissedAt: Date.now(),
          dismissCount: newCount,
        })
      );
    } catch {}

    // 埋点 2：用户主动关闭
    trackEvent({
      eventType: TELEMETRY_EVENTS.UPSTREAM_TOAST_DISMISSED,
      metadata: { owner, repo, dismissCount: newCount },
    });
  };

  const handleViewPlan = () => {
    setPlanOpen(true);

    // 埋点 3：用户点击查看计划
    trackEvent({
      eventType: TELEMETRY_EVENTS.UPSTREAM_TOAST_VIEW_PLAN,
      metadata: { owner, repo },
    });
  };

  if (!visible) {
    // 弹窗依然允许在 planOpen 时挂载
    if (!planOpen) return null;
    return (
      <UpdatePlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        owner={owner}
        repo={repo}
      />
    );
  }

  return (
    <>
      <aside
        aria-label={m.update_toast_found_update()}
        className="fixed top-5 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-300 pointer-events-auto"
      >
        <div className="flex items-center gap-2.5 pl-3.5 pr-2 py-1.5 rounded-full bg-theme-surface/95 backdrop-blur-md border border-theme-border shadow-lg text-xs text-theme-foreground">
          <div className="flex items-center gap-1.5 font-medium shrink-0">
            <ArrowUpCircle className="w-4 h-4 text-theme-primary shrink-0" />
            <span>{m.update_toast_found_update()}</span>
          </div>

          <div className="h-3 w-px bg-theme-border shrink-0" />

          <button
            type="button"
            onClick={handleViewPlan}
            className="px-1.5 py-0.5 rounded text-theme-primary font-semibold hover:underline hover:text-theme-primary/80 active:scale-95 transition-all cursor-pointer shrink-0"
          >
            {m.common_view()}
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            title={m.common_close()}
            aria-label={m.common_close()}
            className="p-1 rounded-full text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/80 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>

      {planOpen && (
        <UpdatePlanDialog
          open={planOpen}
          onOpenChange={setPlanOpen}
          owner={owner}
          repo={repo}
        />
      )}
    </>
  );
}
