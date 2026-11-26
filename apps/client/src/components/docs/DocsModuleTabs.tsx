'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, Check, ChevronDown, Code2, History } from 'lucide-react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import {
  pickActiveModuleTabId,
  resolveModuleTabEntries,
  type ResolvedModuleTab,
} from '@/lib/docs/webdoc-module-tabs';
import type { ModuleTab, ModuleTabKind } from '@/lib/schemas/webdoc-topology';
import { cn } from '@/lib/utils';

export interface DocsModuleTabsProps {
  owner: string;
  repo: string;
  resolvedTabs?: ResolvedModuleTab[];
  moduleTabs?: ModuleTab[];
  allowedPrefixes?: string[];
  importedDocPaths?: string[];
  primaryDocPrefix?: string | null;
  hasOpenApi?: boolean;
  hasChangelogDoc?: boolean;
}

function ModuleKindIcon({ kind }: { kind: ModuleTabKind }) {
  if (kind === 'api') return <Code2 className="size-3.5 shrink-0" />;
  if (kind === 'changelog') return <History className="size-3.5 shrink-0" />;
  return <BookOpen className="size-3.5 shrink-0" />;
}

export function DocsModuleTabs({
  owner,
  repo,
  resolvedTabs,
  moduleTabs,
  allowedPrefixes,
  importedDocPaths,
  primaryDocPrefix,
  hasOpenApi,
  hasChangelogDoc,
}: DocsModuleTabsProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const entries = useMemo(() => {
    if (Array.isArray(resolvedTabs)) return resolvedTabs;
    return resolveModuleTabEntries({
      owner,
      repo,
      moduleTabs,
      allowedPrefixes,
      importedDocPaths,
      hasOpenApi,
      hasChangelogDoc,
    });
  }, [
    resolvedTabs,
    owner,
    repo,
    moduleTabs,
    allowedPrefixes,
    importedDocPaths,
    hasOpenApi,
    hasChangelogDoc,
  ]);

  if (entries.length <= 1) {
    return null;
  }

  const activeId = pickActiveModuleTabId(entries, pathname, owner, repo, primaryDocPrefix);
  const activeTab = entries.find((tab) => tab.id === activeId) ?? entries[0];

  return (
    <div className="flex items-center shrink-0 my-auto">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2 rounded-lg border border-theme-border/70 bg-theme-bg/80 text-xs font-sans font-medium text-theme-foreground hover:bg-theme-surface hover:border-theme-border transition-colors cursor-pointer select-none',
            open && 'bg-theme-surface text-theme-primary border-theme-primary/40 shadow-xs',
          )}
          aria-label={activeTab.label}
          title={activeTab.label}
        >
          <ModuleKindIcon kind={activeTab.kind} />
          <span className="truncate max-w-24">{activeTab.label}</span>
          <ChevronDown
            className={cn(
              'size-3 text-theme-muted transition-transform shrink-0',
              open && 'rotate-180 text-theme-primary',
            )}
          />
        </PopoverTrigger>

        <PopoverPopup
          side="bottom"
          align="start"
          sideOffset={6}
          viewportClassName="p-0"
          className="w-48 max-w-[calc(100vw-2rem)] rounded-xl bg-theme-bg border border-theme-border/80 shadow-xl p-1 overflow-hidden text-left z-[100] focus:outline-none"
        >
          <nav aria-label={activeTab.label} className="flex flex-col gap-0.5">
            {entries.map((tab) => {
              const isActive = tab.id === activeTab.id;
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-sans transition-colors cursor-pointer',
                    isActive
                      ? 'bg-theme-surface text-theme-primary font-semibold'
                      : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/70 font-medium',
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ModuleKindIcon kind={tab.kind} />
                    <span className="truncate">{tab.label}</span>
                  </span>
                  {isActive && <Check className="size-3.5 text-theme-primary shrink-0" />}
                </Link>
              );
            })}
          </nav>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
