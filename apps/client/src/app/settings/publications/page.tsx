'use client';

import React from 'react';
import { Globe } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { PublicationsManagerView } from '@/components/settings/PublicationsManagerView';

export default function SettingsPublicationsPage() {
  return (
    <SettingsShell activeTab="publications">
      <div className="border-b border-theme-border/40 pb-4">
        <h1 className="text-2xl font-bold text-theme-foreground tracking-tight flex items-center gap-2.5">
          <Globe size={22} className="text-theme-primary" />
          {m.publications_page_title()}
        </h1>
        <p className="mt-1 text-xs text-theme-muted">
          {m.publications_page_subtitle()}
        </p>
      </div>
      <PublicationsManagerView />
    </SettingsShell>
  );
}
