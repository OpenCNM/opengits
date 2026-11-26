'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  Drawer,
  DrawerPopup,
  DrawerHeader,
  DrawerTitle,
  DrawerPanel,
  DrawerClose,
} from '@/components/ui/drawer';
import { useCodeDrawerStore } from '@/lib/stores/code-drawer-store';
import { SandboxPre } from '@/components/mdx/SandboxPre';
import { FileCode, ArrowUpRight, Copy, Check, Hash, X } from 'lucide-react';
import { UI_TIMINGS } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import * as m from '@/paraglide/messages';
import type { CodeFileResult } from '@/app/api/code/[owner]/[repo]/file/route';

export interface CodeDrawerProps {
  owner: string;
  repo: string;
  gitSha?: string | null;
}

export function CodeDrawer({ owner, repo, gitSha }: CodeDrawerProps) {
  const isOpen = useCodeDrawerStore((s) => s.isOpen);
  const target = useCodeDrawerStore((s) => s.target);
  const closeDrawer = useCodeDrawerStore((s) => s.closeDrawer);
  const syncFromHash = useCodeDrawerStore((s) => s.syncFromHash);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileData, setFileData] = useState<CodeFileResult | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleHashChange = () => {
      syncFromHash(window.location.hash, {
        owner,
        repo,
        sha: gitSha || undefined,
      });
    };

    handleHashChange();

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [owner, repo, gitSha, syncFromHash]);

  useEffect(() => {
    if (!isOpen || !target?.filePath || !target.owner || !target.repo) {
      return;
    }

    let isCancelled = false;
    setLoading(true);
    setError(null);

    const query = new URLSearchParams({
      path: target.filePath,
    });
    if (target.sha) {
      query.set('sha', target.sha);
    }

    fetch(`/api/code/${target.owner}/${target.repo}/file?${query.toString()}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load file: ${res.statusText}`);
        }
        return res.json();
      })
      .then((json) => {
        if (isCancelled) return;
        const resData: CodeFileResult = json?.data ?? json;
        setFileData(resData);
        setLoading(false);
      })
      .catch((err: any) => {
        if (isCancelled) return;
        setError(err.message || m.code_drawer_load_failed());
        setLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [isOpen, target?.owner, target?.repo, target?.filePath, target?.sha]);

  useEffect(() => {
    if (!fileData || !target?.startLine || !containerRef.current) return;

    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;

      const targetEl = container.querySelector<HTMLElement>(
        `.line[data-line="${target.startLine}"]`
      );
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [fileData, target?.startLine]);

  const handleCopyLink = () => {
    if (typeof window === 'undefined') return;
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), UI_TIMINGS.COPY_FEEDBACK);
  };

  const handleCopyPath = () => {
    if (!target?.filePath || typeof navigator === 'undefined') return;
    navigator.clipboard.writeText(target.filePath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), UI_TIMINGS.COPY_FEEDBACK);
  };

  const refSha = target?.sha || gitSha || ENGINE_CONFIG.defaultBranch;
  const cleanPath = target?.filePath ? target.filePath.replace(/^\.?\//, '') : '';
  const lineHash =
    target?.startLine && target.startLine > 0
      ? `#L${target.startLine}${
          target.endLine && target.endLine !== target.startLine
            ? `-L${target.endLine}`
            : ''
        }`
      : '';
  const githubUrl = `https://github.com/${target?.owner || owner}/${
    target?.repo || repo
  }/blob/${refSha}/${cleanPath}${lineHash}`;

  const pathParts = cleanPath.split('/');

  return (
    <Drawer
      position="right"
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeDrawer();
      }}
    >
      <DrawerPopup
        position="right"
        className="w-full sm:max-w-2xl lg:max-w-3xl border-l border-theme-border bg-theme-bg text-theme-foreground shadow-2xl z-50 flex flex-col h-full"
      >
        <DrawerHeader className="border-b border-theme-border/60 bg-theme-surface/50 p-4 pb-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <FileCode className="w-4 h-4 text-theme-primary shrink-0" />
              <DrawerTitle className="text-sm font-mono font-medium truncate flex items-center gap-1">
                {pathParts.map((part, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && <span className="text-theme-muted/50">/</span>}
                    <span
                      className={
                        idx === pathParts.length - 1
                          ? 'text-theme-foreground font-semibold'
                          : 'text-theme-muted'
                      }
                    >
                      {part}
                    </span>
                  </React.Fragment>
                ))}
              </DrawerTitle>
              <button
                type="button"
                onClick={handleCopyPath}
                title={m.code_drawer_copy_path()}
                className="p-1 rounded text-theme-muted hover:text-theme-foreground hover:bg-theme-bg transition-colors"
              >
                {copiedPath ? (
                  <Check className="w-3.5 h-3.5 text-theme-primary" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleCopyLink}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono bg-theme-surface hover:bg-theme-bg border border-theme-border text-theme-foreground transition-colors cursor-pointer"
                title={m.code_drawer_copy_permalink()}
              >
                {copiedLink ? (
                  <Check className="w-3.5 h-3.5 text-theme-primary" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedLink ? m.code_drawer_copied_link() : m.code_drawer_share_link()}</span>
              </button>

              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-theme-surface hover:bg-theme-bg border border-theme-border text-theme-foreground hover:text-theme-primary transition-colors cursor-pointer"
                title={m.code_drawer_open_github()}
              >
                <span>GitHub</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </a>

              <DrawerClose
                className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
                aria-label={m.code_drawer_close_aria()}
              >
                <X className="w-4 h-4" />
              </DrawerClose>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono">
            {target?.startLine ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-theme-primary/10 text-theme-primary border border-theme-primary/20">
                <Hash className="w-3 h-3" />
                <span>
                  L{target.startLine}
                  {target.endLine && target.endLine !== target.startLine
                    ? `-L${target.endLine}`
                    : ''}
                </span>
              </span>
            ) : null}

            {target?.symbol && (
              <span className="px-2 py-0.5 rounded bg-theme-surface border border-theme-border text-theme-muted truncate max-w-xs">
                {m.code_drawer_symbol_label()}{target.symbol}
              </span>
            )}

            {fileData?.totalLines && (
              <span className="text-theme-muted text-micro">
                {m.code_drawer_line_count({ count: fileData.totalLines })}
              </span>
            )}
          </div>
        </DrawerHeader>

        <DrawerPanel className="flex-1 overflow-y-auto p-0 bg-theme-surface/30">
          <div ref={containerRef} className="p-4">
            {loading ? (
              <div className="space-y-3 py-6 animate-pulse">
                <div className="h-4 bg-theme-border/50 rounded w-1/3" />
                <div className="h-3 bg-theme-border/40 rounded w-full" />
                <div className="h-3 bg-theme-border/40 rounded w-5/6" />
                <div className="h-3 bg-theme-border/30 rounded w-4/6" />
                <div className="h-3 bg-theme-border/30 rounded w-full" />
              </div>
            ) : error ? (
              <div className="py-12 text-center text-sm font-mono text-theme-muted">
                {error}
              </div>
            ) : fileData ? (
              <SandboxPre
                filename={fileData.filePath}
                file={fileData.filePath}
                data-language={fileData.language}
                lang={fileData.language}
                data-git-sha={fileData.sha}
                data-code={fileData.content}
              >
                <code>{fileData.content}</code>
              </SandboxPre>
            ) : null}
          </div>
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
