import * as m from '@/paraglide/messages';
import React from 'react';
import Link from 'next/link';
import { McpQueryLogStream } from '@/components/telemetry/McpQueryLogStream';
import { SubpageContainer } from '@/components/layout/SubpageContainer';

export default function AnalyticsQueriesPage() {
  return (
    <SubpageContainer
      maxWidth="6xl"
      headerNav={
        <nav className="flex items-center gap-4 text-xs font-serif">
          <Link
            href="/settings/usage"
            className="px-2.5 py-1 rounded text-theme-muted hover:text-theme-foreground transition-colors"
          >
            {m.user_menu_usage()}
          </Link>
          <span className="px-2.5 py-1 rounded font-bold text-theme-foreground bg-theme-surface border border-theme-border/60">
            {m.usage_mcp_details_link()}
          </span>
        </nav>
      }
    >
      <McpQueryLogStream />
    </SubpageContainer>
  );
}
