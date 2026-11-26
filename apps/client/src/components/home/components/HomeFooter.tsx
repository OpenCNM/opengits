'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { OpenGitsOctocatLogo } from './OpenGitsOctocatLogo';
import {
  OFFICIAL_GITHUB_URL,
  OFFICIAL_FEEDBACK_URL,
  OFFICIAL_CHANGELOG_URL,
  OFFICIAL_SUPPORT_EMAIL,
} from '@/lib/constants';
import * as m from '@/paraglide/messages';

interface HomeFooterProps {
  className?: string;
  isDashboard?: boolean;
}

export function HomeFooter({ className = '', isDashboard = false }: HomeFooterProps) {
  if (isDashboard) {
    return (
      <footer
        className={`relative z-10 w-full bg-theme-bg border-t border-theme-border/60 text-xs text-theme-muted font-sans select-none pt-3 pb-1 ${className}`}
      >
        <div className="w-full flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <Link href="/" className="inline-flex items-center gap-1.5 group">
              <div className="flex items-center justify-center shrink-0">
                <OpenGitsOctocatLogo className="w-3.5 h-3.5 text-theme-muted group-hover:text-theme-foreground transition-colors" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-theme-muted group-hover:text-theme-foreground font-mono leading-none transition-colors">
                opengits
              </span>
            </Link>
            <span className="text-theme-border">·</span>
            <span className="text-micro font-mono text-theme-muted/70">
              {m.footer_copyright()}
            </span>
          </div>

          <nav className="flex flex-wrap items-center gap-x-4 sm:gap-x-5 gap-y-1.5 text-xs">
            <a
              href={OFFICIAL_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_github()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <a
              href={OFFICIAL_FEEDBACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_feedback()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <a
              href={OFFICIAL_CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_changelog()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <Link href="/legal/terms" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_terms()}
            </Link>
            <Link href="/legal/privacy" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_privacy()}
            </Link>
            <span className="text-theme-border hidden sm:inline">·</span>
            <a
              href={`mailto:${OFFICIAL_SUPPORT_EMAIL}`}
              className="hover:text-theme-foreground transition-colors text-micro font-mono text-theme-muted/70 hidden sm:inline"
            >
              {OFFICIAL_SUPPORT_EMAIL}
            </a>
          </nav>
        </div>
      </footer>
    );
  }

  return (
    <footer
      className={`relative z-10 w-full bg-theme-bg border-t border-theme-border/60 text-xs text-theme-muted font-sans select-none mt-auto py-6 sm:py-8 ${className}`}
    >
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-3">

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">

          <div className="flex items-center gap-2.5">
            <Link href="/" className="inline-flex items-center gap-2 group">
              <div className="flex items-center justify-center shrink-0">
                <OpenGitsOctocatLogo className="w-4 h-4 text-theme-muted group-hover:text-theme-foreground transition-colors" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-theme-muted group-hover:text-theme-foreground font-mono leading-none transition-colors">
                opengits
              </span>
            </Link>
            <span className="text-theme-border hidden sm:inline">·</span>
            <span className="text-xs text-theme-muted/80 hidden sm:inline">
              {m.footer_tagline()}
            </span>
          </div>

          <nav className="flex flex-wrap items-center gap-x-4 sm:gap-x-5 gap-y-2 text-xs">
            <Link href="/" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_explore()}
            </Link>
            <Link href="/docs" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_mcp_hub()}
            </Link>
            <a
              href={OFFICIAL_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_github()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <a
              href={OFFICIAL_FEEDBACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_feedback()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <a
              href={OFFICIAL_CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors"
            >
              <span>{m.footer_changelog()}</span>
              <ArrowUpRight className="w-3 h-3 text-theme-muted/60 shrink-0" />
            </a>
            <Link href="/legal/terms" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_terms()}
            </Link>
            <Link href="/legal/privacy" className="text-theme-muted hover:text-theme-foreground transition-colors">
              {m.footer_privacy()}
            </Link>
          </nav>

        </div>

        <div className="pt-1.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-micro text-theme-muted/70 font-mono">
          <div className="flex items-center gap-2">
            <span>{m.footer_copyright()}</span>
            <span className="hidden sm:inline text-theme-border">·</span>
            <span className="hidden sm:inline">{m.footer_built_for()}</span>
          </div>

          <div>
            <a
              href={`mailto:${OFFICIAL_SUPPORT_EMAIL}`}
              className="hover:text-theme-foreground transition-colors"
            >
              {OFFICIAL_SUPPORT_EMAIL}
            </a>
          </div>
        </div>

      </div>
    </footer>
  );
}
