import React from 'react';
import { McpTokensManager } from '@/components/settings/McpTokensManager';
import { SettingsShell } from '@/components/settings/SettingsShell';

export default function SettingsMcpTokensPage() {
  return (
    <SettingsShell activeTab="mcp-tokens">
      <McpTokensManager />
    </SettingsShell>
  );
}
