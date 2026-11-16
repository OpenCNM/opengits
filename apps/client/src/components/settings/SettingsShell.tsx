'use client';

import React, { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, Globe, BarChart3, KeyRound, Sparkles, User } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';

export type SettingsTab = 'publications' | 'usage' | 'mcp-tokens' | 'api-keys' | 'account';

interface SettingsShellProps {
  activeTab: SettingsTab;
  children: ReactNode;
  className?: string;
}

interface TabDef {
  id: SettingsTab;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function SettingsShell({
  activeTab,
  children,
  className = '',
}: SettingsShellProps) {
  const tabs: TabDef[] = [
    {
      id: 'publications',
      label: m.user_menu_publications(),
      href: '/settings/publications',
      icon: Globe,
    },
    {
      id: 'usage',
      label: m.user_menu_usage(),
      href: '/settings/usage',
      icon: BarChart3,
    },
    {
      id: 'mcp-tokens',
      label: m.user_menu_mcp_tokens(),
      href: '/settings/mcp-tokens',
      icon: KeyRound,
    },
    {
      id: 'api-keys',
      label: m.user_menu_api_keys(),
      href: '/settings/api-keys',
      icon: Sparkles,
    },
    {
      id: 'account',
      label: m.user_menu_account(),
      href: '/settings/account',
      icon: User,
    },
  ];

  return (
    <div className="min-h-screen bg-theme-bg font-sans text-theme-foreground">
      <div className={`max-w-5xl mx-auto px-4 py-8 sm:py-12 ${className}`}>
        {/* 顶部返回导航：统一左侧返回按钮，右侧干净不显示通知/头像 */}
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-sans text-theme-foreground border border-theme-border/60 hover:border-theme-primary hover:text-theme-primary transition-colors cursor-pointer select-none shadow-2xs shrink-0"
            title={m.account_back_to_workspace()}
          >
            <ChevronLeft size={16} />
            <span>{m.account_back_to_workspace()}</span>
          </Link>
        </div>

        {/* 统一顶栏 Tabs 切换器：5 个选项使用完全相同的胶囊组件，视觉与宽度绝对统一 */}
        <div className="mb-8">
          <div className="flex items-center h-10 p-1 bg-theme-surface/50 border border-theme-border/70 rounded-xl gap-1 overflow-x-auto custom-scrollbar">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={cn(
                    'flex-1 h-8 min-w-[120px] px-3 flex items-center justify-center gap-2 text-xs sm:text-sm rounded-lg transition-all duration-150 cursor-pointer select-none font-medium text-center shrink-0',
                    isActive
                      ? 'bg-theme-bg text-theme-foreground font-semibold shadow-xs border border-theme-border/80'
                      : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/60 border border-transparent'
                  )}
                >
                  <Icon className={cn('w-4 h-4 shrink-0', isActive ? 'text-theme-primary' : 'text-theme-muted')} />
                  <span className="truncate whitespace-nowrap">{tab.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* 统一内容展示区 */}
        <main className="space-y-6">{children}</main>
      </div>
    </div>
  );
}
