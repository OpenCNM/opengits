'use client';

import React from 'react';
import { signIn } from 'next-auth/react';
import { BookmarkPlus, Sparkles } from 'lucide-react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { usePermissionStore } from '@/lib/permissions/permission-store';
import * as m from '@/paraglide/messages';

export function PermissionGateModal() {
  const isOpen = usePermissionStore((s) => s.permissionGateOpen);
  const gateOptions = usePermissionStore((s) => s.gateOptions);
  const closeGate = usePermissionStore((s) => s.closePermissionGate);

  if (!gateOptions) return null;

  const isAiLevel = gateOptions.level === 'AI_COMPUTE';
  const defaultTitle = isAiLevel ? m.gate_ai_compute_title() : m.gate_user_asset_title();
  const defaultDesc = isAiLevel ? m.gate_ai_compute_desc() : m.gate_user_asset_desc();
  const title = gateOptions.title || defaultTitle;
  const contextDesc = gateOptions.contextText || defaultDesc;

  const handleGitHubSignIn = () => {
    closeGate();
    const callbackUrl = typeof window !== 'undefined' ? window.location.href : '/';
    void signIn('github', { callbackUrl });
  };

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={closeGate}
      size="sm"
      className="p-0 overflow-hidden"
    >
      <div className="relative p-6 sm:p-7 flex flex-col items-center text-center font-sans">
        {/* Glow Accent Backdrop */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-24 bg-theme-primary/10 rounded-full blur-2xl pointer-events-none" />

        {/* Icon Emblem */}
        <div className="relative z-10 w-12 h-12 rounded-2xl bg-theme-surface border border-theme-border/80 flex items-center justify-center text-theme-primary mb-4 shadow-sm">
          {isAiLevel ? (
            <Sparkles className="w-6 h-6 animate-pulse" />
          ) : (
            <BookmarkPlus className="w-6 h-6" />
          )}
        </div>

        {/* Title & Description */}
        <h3 className="relative z-10 text-base sm:text-lg font-semibold tracking-tight text-theme-foreground mb-2">
          {title}
        </h3>

        <p className="relative z-10 text-xs text-theme-muted leading-relaxed max-w-sm mb-6">
          {contextDesc}
        </p>

        {/* Actions */}
        <div className="relative z-10 w-full flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleGitHubSignIn}
            className="group w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl bg-theme-primary text-theme-primary-fg text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer shadow-sm"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 transition-transform group-hover:rotate-6">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            <span>{isAiLevel ? m.gate_login_and_bind_btn() : m.gate_login_github_btn()}</span>
          </button>

          <button
            type="button"
            onClick={closeGate}
            className="w-full py-2 rounded-xl text-xs text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/60 transition-colors cursor-pointer"
          >
            {m.gate_dismiss_btn()}
          </button>
        </div>
      </div>
    </AnimatedModal>
  );
}
