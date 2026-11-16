'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useEffect, useRef } from 'react';
import { Check, Copy, FileCode, Sparkles } from 'lucide-react';
import defaultComponents from 'fumadocs-ui/mdx';
import { scoreCodeComplexity } from '@/lib/code-complexity';
import { useCodeGroupContext } from '@/components/mdx/CodeGroupContext';
import { UI_TIMINGS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { useCodeDrawerStore } from '@/lib/stores/code-drawer-store';
import { extractCodeExplainContext } from '@/lib/code-viewport/explain-context';
import {
  parseLineAnchor,
  formatLineAnchor,
  isLineInRange,
  parseCodeAnchor,
  formatCodeAnchor,
  isCodeAnchorFileMatch,
} from '@/lib/code-viewport/line-anchor';

export function SandboxPre({ children, ...props }: any) {
  const preferFile = props.filename || props.file || props.title || props['data-title'] || undefined;

  const [copied, setCopied] = useState(false);
  const [deepDiveSent, setDeepDiveSent] = useState(false);
  const { isInGroup } = useCodeGroupContext();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const codeContainerRef = useRef<HTMLDivElement | null>(null);
  const deepDiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deepDiveTimerRef.current) {
        clearTimeout(deepDiveTimerRef.current);
      }
    };
  }, []);

 // Clean language extraction
 let rawLang = props['data-language'] || props.lang || props.className || '';
 if ((!rawLang || rawLang.includes('shiki')) && children && typeof children === 'object') {
 const childProps = (children as any).props || {};
 if (childProps.className || childProps['data-language']) {
 rawLang = `${rawLang} ${childProps['data-language'] || childProps.className || ''}`;
 }
 }

 let extractedLang = '';
 if (typeof rawLang === 'string' && rawLang.trim()) {
 const langMatch = rawLang.match(/language-([a-zA-Z0-9+#-]+)/);
 if (langMatch && langMatch[1]) {
 extractedLang = langMatch[1];
 } else {
 const words = rawLang.split(/\s+/).filter(
 (w) =>
 w &&
 !w.toLowerCase().includes('shiki') &&
 !w.toLowerCase().includes('github-light') &&
 !w.toLowerCase().includes('github-dark')
 );
 if (words.length > 0) {
 extractedLang = words[0].replace(/^language-/, '');
 }
 }
 }

 if (
 extractedLang.toLowerCase().includes('github-light') ||
 extractedLang.toLowerCase().includes('github-dark') ||
 extractedLang.toLowerCase().includes('shiki')
 ) {
 extractedLang = '';
 }

 const langDisplay = extractedLang ? extractedLang.toUpperCase() : 'CODE';

 // Extract raw code text
 let codeText =
  props['data-code'] ||
  props.dataCode ||
  props['dataCode'] ||
  props.code ||
  props['data-raw-code'] ||
  props['rawcode'] ||
  '';

 if (!codeText && children && typeof children === 'object') {
  const childProps = (children as any).props || {};
  codeText =
    childProps['data-code'] ||
    childProps.dataCode ||
    childProps['dataCode'] ||
    childProps.code ||
    childProps['data-raw-code'] ||
    childProps['rawcode'] ||
    '';
 }

 if (!codeText) {
  const extractText = (node: any): string => {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
      return node.map(extractText).join('');
    }
    if (node && typeof node === 'object') {
      if (node.props?.['data-code'] || node.props?.dataCode) {
        return node.props['data-code'] || node.props.dataCode;
      }
      if (node.props?.children) {
        const text = extractText(node.props.children);
        const className = String(node.props.className || '');
        if (
          className.includes('line') ||
          node.props['data-line'] !== undefined ||
          node.type === 'div' ||
          node.type === 'tr' ||
          node.type === 'p'
        ) {
          return text + (text.endsWith('\n') ? '' : '\n');
        }
        return text;
      }
    }
    return '';
  };
  codeText = extractText(children).replace(/\n{3,}/g, '\n\n').trim();
 }

 if (codeText) {
  codeText = codeText.replace(/\r?\n$/, '');
 }

 const lineCount = codeText ? codeText.split('\n').length : 0;
 const gutterDigits = Math.max(1, String(lineCount || 1).length);
 const gutterWidth = `${Math.max(1.25, gutterDigits * 1 + 0.25)}ch`;
 const isSnippetTruncated = Boolean(props['data-is-snippet'] || props['data-truncated']);

 const complexityScore = scoreCodeComplexity(codeText, langDisplay);
 const shouldShowDissection = complexityScore >= 15 && !isSnippetTruncated;

 const handleCopy = (e: React.MouseEvent) => {
   e.stopPropagation();
   if (codeText && typeof navigator !== 'undefined') {
     navigator.clipboard.writeText(codeText);
     setCopied(true);
     setTimeout(() => setCopied(false), 2000);
   }
 };

 const handleDeepDive = (e: React.MouseEvent) => {
   e.stopPropagation();
   if (!codeText) return;

   const drawerState = useCodeDrawerStore.getState();
   const context = extractCodeExplainContext({
     element: rootRef.current ?? codeContainerRef.current,
     code: codeText,
     language: extractedLang || langDisplay,
     filePath: props.filename || props.file || undefined,
     title: props.title || props['data-title'] || undefined,
     lineCount,
     drawerState: {
       isOpen: drawerState.isOpen,
       target: drawerState.target,
     },
   });

   if (drawerState.isOpen) {
     drawerState.closeDrawer();
   }

   useModalStore.getState().triggerDeepDive(context);
   setDeepDiveSent(true);
   if (deepDiveTimerRef.current) {
     clearTimeout(deepDiveTimerRef.current);
   }
   deepDiveTimerRef.current = setTimeout(() => setDeepDiveSent(false), UI_TIMINGS.COPY_FEEDBACK);
 };

  const DefaultPre = (defaultComponents as any).pre || 'pre';
  const serverHtml = props['data-highlighted-html'] || props.dataHighlightedHtml;

  const {
    gitSha: _unusedGitSha,
    filename: _unusedFilename,
    file: _unusedFile,
    dataCode: _unusedDataCode,
    dataHighlightedHtml: _unusedDataHighlightedHtml,
    rawcode: _unusedRawcode,
    code: _unusedCode,
    ...preDomProps
  } = props;

  const renderCodeBody = () => {
    if (serverHtml) {
      return (
        <div
          className="shiki-wasm-content [&_pre]:!m-0 [&_pre]:!border-none [&_pre]:!bg-transparent [&_pre]:!shadow-none [&_pre]:!p-0 font-mono text-xs"
          dangerouslySetInnerHTML={{ __html: serverHtml }}
        />
      );
    }
    return <DefaultPre {...preDomProps}>{children}</DefaultPre>;
  };

  const syncHashAnchor = (hash: string, shouldScroll = false) => {
    const container = codeContainerRef.current;
    if (!container) return;

    const codeTarget = parseCodeAnchor(hash);
    const isFileMatch = isCodeAnchorFileMatch(codeTarget?.filePath, preferFile);
    const range = isFileMatch ? (codeTarget?.range ?? null) : null;

    const lineNodes = container.querySelectorAll<HTMLElement>('.line[data-line]');
    if (lineNodes.length === 0) return;

    let targetEl: HTMLElement | null = null;
    lineNodes.forEach((node) => {
      const line = parseInt(node.getAttribute('data-line') || '0', 10);
      const active = isLineInRange(line, range);
      node.classList.toggle('is-active-line', active);
      if (range && line === range.startLine && !targetEl) {
        targetEl = node;
      }
    });

    if (shouldScroll && targetEl) {
      (targetEl as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const updateHashForLine = (lineNum: number, isShift: boolean) => {
    if (typeof window === 'undefined') return;

    const currentHash = window.location.hash;
    const currentAnchor = parseCodeAnchor(currentHash);
    const currentRange = currentAnchor?.range ?? null;

    let nextHash: string;
    if (preferFile) {
      const cleanFile = preferFile.replace(/^\.?\//, '');
      if (isShift && currentRange) {
        nextHash = formatCodeAnchor({ filePath: cleanFile, startLine: currentRange.startLine, endLine: lineNum });
      } else if (currentRange && currentRange.startLine === lineNum && currentRange.endLine === lineNum && currentAnchor?.filePath === cleanFile) {
        nextHash = '';
      } else {
        nextHash = formatCodeAnchor({ filePath: cleanFile, startLine: lineNum });
      }
    } else {
      if (isShift && currentRange) {
        nextHash = formatLineAnchor(currentRange.startLine, lineNum);
      } else if (currentRange && currentRange.startLine === lineNum && currentRange.endLine === lineNum) {
        nextHash = '';
      } else {
        nextHash = formatLineAnchor(lineNum);
      }
    }

    const nextUrl = nextHash
      ? `${window.location.pathname}${window.location.search}${nextHash}`
      : `${window.location.pathname}${window.location.search}`;

    window.history.replaceState(null, '', nextUrl);
    window.dispatchEvent(new Event('hashchange'));
  };

  const handleCodeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    const lineEl = target.closest<HTMLElement>('.line[data-line]');
    if (!lineEl) return;

    const lineStr = lineEl.getAttribute('data-line');
    const lineNum = lineStr ? parseInt(lineStr, 10) : 0;
    if (Number.isNaN(lineNum) || lineNum <= 0) return;

    const rect = lineEl.getBoundingClientRect();
    const isGutterClick = e.clientX - rect.left <= 36 || target === lineEl;
    if (!isGutterClick && !e.shiftKey) return;

    e.preventDefault();
    updateHashForLine(lineNum, e.shiftKey);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onHashChange = () => {
      syncHashAnchor(window.location.hash, false);
    };

    syncHashAnchor(window.location.hash, true);
    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [serverHtml]);

  if (isInGroup) {
    return (
      <div className="relative">
        <div
          ref={codeContainerRef}
          style={{ '--line-gutter-width': gutterWidth } as React.CSSProperties}
          className="relative overflow-x-auto p-0 leading-relaxed text-theme-foreground bg-theme-surface [&_figure]:!m-0 [&_figure]:!border-none [&_figure]:!bg-transparent [&_pre]:!m-0 [&_pre]:!border-none [&_pre]:!bg-transparent [&_pre]:!shadow-none [&_button]:!hidden"
          onClick={handleCodeClick}
        >
          {renderCodeBody()}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="group relative rounded-xl border border-theme-border/60 bg-theme-surface my-6 shadow-2xs overflow-hidden text-xs font-mono transition-colors"
    >
      {/* Integrated Terminal Header Bar */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-theme-border/40 select-none bg-theme-surface/60 backdrop-blur-xs">
        {/* Left: Language & Metadata */}
        <div className="flex items-center gap-2 text-theme-muted">
          <div className="flex items-center gap-1.5 font-mono text-caption font-semibold tracking-wider text-theme-foreground/90 uppercase">
            <FileCode size={13} className="text-theme-muted/80 shrink-0" />
            <span>{langDisplay}</span>
          </div>
          <span className="text-theme-border font-mono select-none text-xs">/</span>
          <span suppressHydrationWarning className="text-caption font-mono text-theme-muted/70">
            {lineCount} {m.code_lines_count()}
          </span>
        </div>

        {/* Right: Action Buttons (AI 解释 + 复制) */}
        <div className="flex items-center gap-1.5">
          {shouldShowDissection && (
            <button
              type="button"
              onClick={handleDeepDive}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-caption font-medium rounded-md transition-all cursor-pointer active:scale-95 ${
                deepDiveSent
                  ? 'bg-theme-primary/10 text-theme-primary'
                  : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-primary/5'
              }`}
              title={m.code_ai_explain()}
            >
              {deepDiveSent ? (
                <Check size={12} className="text-theme-primary" />
              ) : (
                <Sparkles size={12} className="text-theme-primary/80" />
              )}
              <span className={deepDiveSent ? 'text-theme-primary font-medium' : undefined}>
                {m.code_ai_explain()}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-caption font-medium text-theme-muted hover:text-theme-foreground hover:bg-theme-primary/5 active:scale-95 transition-all cursor-pointer"
            title={m.common_copy()}
          >
            {copied ? (
              <>
                <Check size={13} className="text-emerald-600 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">{m.common_copied()}</span>
              </>
            ) : (
              <>
                <Copy size={13} className="text-theme-muted/80 group-hover:text-theme-foreground transition-colors" />
                <span>{m.common_copy()}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Clean Code Body Container */}
      <div
        ref={codeContainerRef}
        style={{ '--line-gutter-width': gutterWidth } as React.CSSProperties}
        className="relative overflow-x-auto px-3.5 py-3.5 leading-relaxed text-theme-foreground bg-theme-surface [&_figure]:!m-0 [&_figure]:!border-none [&_figure]:!bg-transparent [&_pre]:!m-0 [&_pre]:!border-none [&_pre]:!bg-transparent [&_pre]:!shadow-none [&_button]:!hidden"
        onClick={handleCodeClick}
      >
        {renderCodeBody()}
      </div>
    </div>
  );
}
