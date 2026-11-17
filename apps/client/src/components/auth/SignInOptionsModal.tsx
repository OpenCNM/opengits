'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Compass, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { toastManager } from '@/components/ui/toast';
import { usePermissionStore } from '@/lib/permissions/permission-store';
import { useGuestStore } from '@/lib/stores/guest-store';
import * as m from '@/paraglide/messages';

export function SignInOptionsModal() {
  const router = useRouter();
  const isOpen = usePermissionStore((s) => s.signInOptionsOpen);
  const args = usePermissionStore((s) => s.signInOptionsArgs);
  const closeModal = usePermissionStore((s) => s.closeSignInOptions);

  const handleGitHubLogin = () => {
    const callbackUrl = args?.targetRepo
      ? `/docs/${args.targetRepo.owner}/${args.targetRepo.repo}`
      : args?.callbackUrl || (typeof window !== 'undefined' ? window.location.href : '/');
    closeModal();
    void signIn('github', { callbackUrl });
  };

  const handleGuestContinue = () => {
    const repoIdentifier = args?.targetRepo
      ? `${args.targetRepo.owner}/${args.targetRepo.repo}`
      : null;
    useGuestStore.getState().setGuestMode(true, repoIdentifier);
    toastManager.add({
      type: 'info',
      title: m.auth_guest_welcome_toast(),
    });
    closeModal();

    if (args?.targetRepo) {
      router.push(`/docs/${args.targetRepo.owner}/${args.targetRepo.repo}`);
    } else if (args?.callbackUrl && args.callbackUrl !== '/auth/signin') {
      router.push(args.callbackUrl);
    } else {
      router.push('/');
    }
  };

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={closeModal}
      size="md"
      className="p-0 overflow-hidden"
    >
      <div className="relative p-6 sm:p-8 flex flex-col font-sans">
        {/* Top Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-theme-primary/10 rounded-full blur-3xl pointer-events-none" />

        {/* Modal Header */}
        <div className="relative z-10 flex flex-col items-center text-center mb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-theme-border/80 bg-theme-surface/70 text-theme-muted text-micro font-medium mb-3">
            <Sparkles className="w-3 h-3 text-theme-primary" />
            <span>OpenGits</span>
          </div>

          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-theme-foreground mb-1.5">
            {m.auth_modal_title()}
          </h2>
          <p className="text-xs text-theme-muted max-w-sm">
            {m.auth_modal_subtitle()}
          </p>
        </div>

        {/* Target Repo Highlight (if opening for a specific tutorial) */}
        {args?.targetRepo && (
          <div className="relative z-10 mb-5 p-3 rounded-xl border border-theme-border/60 bg-theme-surface/40 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-theme-muted">{m.common_read()}:</span>
              <span className="font-mono font-medium text-theme-foreground truncate">
                {args.targetRepo.owner}/{args.targetRepo.repo}
              </span>
            </div>
            {args.targetRepo.title && (
              <span className="text-micro text-theme-muted truncate max-w-[140px]">
                {args.targetRepo.title}
              </span>
            )}
          </div>
        )}

        {/* Option Cards Stack */}
        <div className="relative z-10 flex flex-col gap-3">
          {/* Option A: GitHub Login (Recommended) */}
          <button
            type="button"
            onClick={handleGitHubLogin}
            className="group relative w-full p-4 rounded-2xl border-2 border-theme-primary/30 hover:border-theme-primary bg-theme-surface/60 hover:bg-theme-surface transition-all text-left flex items-start gap-4 cursor-pointer shadow-sm active:scale-[0.99]"
          >
            <div className="w-10 h-10 rounded-xl bg-theme-primary text-theme-primary-fg flex items-center justify-center shrink-0 shadow-sm transition-transform group-hover:scale-105">
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-theme-foreground group-hover:text-theme-primary transition-colors">
                  {m.auth_modal_github_title()}
                </span>
                <span className="px-1.5 py-0.5 rounded text-micro font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20">
                  {m.auth_modal_github_badge()}
                </span>
              </div>
              <p className="text-xs text-theme-muted leading-relaxed">
                {m.auth_modal_github_desc()}
              </p>
            </div>

            <div className="shrink-0 self-center text-theme-muted group-hover:text-theme-primary group-hover:translate-x-0.5 transition-all">
              <ArrowRight className="w-4 h-4" />
            </div>
          </button>

          {/* Option B: Continue as Guest */}
          <button
            type="button"
            onClick={handleGuestContinue}
            className="group relative w-full p-4 rounded-2xl border border-theme-border/80 hover:border-theme-border bg-theme-surface/40 hover:bg-theme-surface/80 transition-all text-left flex items-start gap-4 cursor-pointer active:scale-[0.99]"
          >
            <div className="w-10 h-10 rounded-xl bg-theme-surface border border-theme-border/80 text-theme-foreground flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Compass className="w-5 h-5 text-theme-primary" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-theme-foreground">
                  {m.auth_modal_guest_title()}
                </span>
                <span className="px-1.5 py-0.5 rounded text-micro font-medium bg-theme-surface text-theme-muted border border-theme-border/60">
                  {m.auth_modal_guest_badge()}
                </span>
              </div>
              <p className="text-xs text-theme-muted leading-relaxed">
                {m.auth_modal_guest_desc()}
              </p>
            </div>

            <div className="shrink-0 self-center text-theme-muted group-hover:text-theme-foreground group-hover:translate-x-0.5 transition-all">
              <ArrowRight className="w-4 h-4" />
            </div>
          </button>
        </div>

        {/* Footnote */}
        <div className="relative z-10 mt-6 pt-4 border-t border-theme-border/40 flex items-center justify-center gap-2 text-micro text-theme-muted">
          <ShieldCheck className="w-3.5 h-3.5 text-theme-muted" />
          <span>{m.auth_modal_footer_note()}</span>
        </div>
      </div>
    </AnimatedModal>
  );
}
