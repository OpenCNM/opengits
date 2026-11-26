'use client';

import React from 'react';
import { useModalStore } from '@/lib/stores/modal-store';

interface DocsSplitShellProps {
  children: React.ReactNode;
  aside: React.ReactNode;
  navButton?: React.ReactNode;
}

export function DocsSplitShell({ children, aside, navButton }: DocsSplitShellProps) {
  const isChatOpen = useModalStore((s) => s.isChatDrawerOpen);

  return (
    <div
      data-ai-open={isChatOpen ? 'true' : 'false'}
      className="relative flex min-h-dvh w-full bg-theme-bg"
    >
      <div
        id="docs-workspace-container"
        className="relative flex-1 min-w-0 [container-type:inline-size] [container-name:docs-shell]"
      >
        {children}
        {navButton}
      </div>
      {aside}
    </div>
  );
}
