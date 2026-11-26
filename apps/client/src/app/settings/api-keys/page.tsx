import React from 'react';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { LlmProvidersManager } from '@/components/settings/LlmProvidersManager';

export default function SettingsApiKeysPage() {
  return (
    <SettingsShell activeTab="api-keys">
      <LlmProvidersManager />
    </SettingsShell>
  );
}
