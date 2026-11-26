'use client';

import React from 'react';
import { BarChart3 } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { UsageStatisticsView } from '@/components/analytics/UsageStatisticsView';

export default function SettingsUsagePage() {
  return (
    <SettingsShell activeTab="usage">
      <div className="border-b border-theme-border/40 pb-4">
        <h1 className="text-2xl font-bold text-theme-foreground tracking-tight flex items-center gap-2.5">
          <BarChart3 size={22} className="text-theme-primary" />
          {m.user_menu_usage()}
        </h1>
      </div>
      <UsageStatisticsView />
    </SettingsShell>
  );
}

