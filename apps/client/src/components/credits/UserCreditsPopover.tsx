'use client';
import * as m from '@/paraglide/messages';

import React, { useEffect } from 'react';
import { Zap, RefreshCw } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useSafeSession } from '@/lib/useSafeSession';
import { useUserCreditsStore, type UserCreditsData } from '@/lib/stores/user-credits-store';

import { getLocale } from '@/paraglide/runtime.js';

export type { UserCreditsData };

export function UserCreditsPopover({ className }: { className?: string }) {
  const { data: session } = useSafeSession();
  const data = useUserCreditsStore((s) => s.data);
  const loading = useUserCreditsStore((s) => s.loading);
  const fetchCredits = useUserCreditsStore((s) => s.fetchCredits);
  const resetCredits = useUserCreditsStore((s) => s.reset);

  useEffect(() => {
    if (!session?.user?.id) {
      resetCredits();
      return;
    }
    fetchCredits();
  }, [session?.user?.id, fetchCredits, resetCredits]);

  if (!session?.user?.id && !data?.loggedIn) {
    return null;
  }

  const available = data?.creditBalance ?? 0;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'group flex items-center gap-1.5 h-8 px-2.5 rounded-lg hover:bg-theme-surface text-xs font-mono tabular-nums text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer select-none shadow-none',
          className
        )}
        aria-label={m.credits_title()}
        title={m.credits_title()}
      >
        <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 group-hover:scale-105 transition-transform shrink-0" />
        <span className="font-medium tracking-tight text-theme-foreground/90 group-hover:text-theme-foreground transition-colors tabular-nums">
          {available.toLocaleString()}
        </span>
      </PopoverTrigger>

      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[260px] !p-0 rounded-xl bg-theme-bg border border-theme-border shadow-lg text-theme-foreground font-sans z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        viewportClassName="!p-0 flex flex-col"
      >
        {/* Main Content Area */}
        <div className="p-3.5 flex flex-col gap-3">
          {/* Header Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 shrink-0" />
              <span className="text-xs font-bold text-theme-foreground font-sans">{m.credits_title()}</span>
            </div>
            <button
              type="button"
              onClick={() => fetchCredits({ force: true })}
              className="p-1 rounded text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
              title={m.common_refresh()}
              aria-label={m.common_refresh()}
            >
              <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
            </button>
          </div>

          {/* Real Credit Balance Display */}
          <div className="flex flex-col gap-1 p-3 rounded-xl bg-theme-bg/60 border border-theme-border/40">
            <span className="text-caption font-sans text-theme-muted">{m.credits_current_balance()}</span>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-theme-foreground tabular-nums">
                {available.toLocaleString()}
              </span>
              <span className="text-xs font-sans text-theme-muted">{m.credits_title()}</span>
            </div>
          </div>

          {/* Rules Section: Pure Two-Way Economy */}
          <div className="flex flex-col gap-2 pt-1 border-t border-theme-border/30 text-caption font-sans">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-theme-foreground flex items-center gap-1.5 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span>{m.credits_rule_earn_title()}</span>
              </span>
              <span className="text-compact text-theme-muted pl-3 leading-relaxed">
                {m.credits_rule_earn_desc()}
              </span>
            </div>

            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-theme-foreground flex items-center gap-1.5 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                <span>{m.credits_rule_spend_title()}</span>
              </span>
              <span className="text-compact text-theme-muted pl-3 leading-relaxed">
                {m.credits_rule_spend_desc()}
              </span>
            </div>
          </div>
        </div>

        {/* Integrated Subdued Footer: Ledger Link */}
        <div className="px-3.5 py-2.5 bg-theme-bg/60 border-t border-theme-border/40 flex items-center justify-between text-caption font-sans">
          <a
            href="/analytics/credits"
            className="text-caption text-theme-primary/80 hover:text-theme-primary transition-colors flex items-center justify-between w-full group/link"
          >
            <span>{m.credits_ledger_link()}</span>
            <span className="text-compact text-theme-muted group-hover/link:text-theme-primary group-hover/link:translate-x-0.5 transition-all" aria-hidden="true">&rarr;</span>
          </a>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
