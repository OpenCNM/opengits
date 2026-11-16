'use client';

import React from 'react';
import { useModalStore } from '@/lib/stores/modal-store';

interface DocsSplitShellProps {
  children: React.ReactNode;
  aside: React.ReactNode;
  navButton?: React.ReactNode;
}

/**
 * 文档区与 AI 助手的桌面端嵌入式双栏容器（Split-Canvas Shell）
 * - 桌面端打开 AI 助手时，左侧文档工作区按 flex-1 min-w-0 自动收缩让出右栏空间，支持边看原文边提问；
 * - 左侧工作区声明 CSS container-type: inline-size (container-name: docs-shell)，
 *   令 TOC、侧栏与正文内边距按「工作区剩余实际宽度」而非整窗视口宽度自适应折叠，杜绝窄屏变形。
 */
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
