'use client';

import React, { useRef, useState } from 'react';
import { Copy, Check, Sparkles, FileCode } from 'lucide-react';
import { CodeGroupProvider } from '@/components/mdx/CodeGroupContext';
import { scoreCodeComplexity } from '@/lib/code-complexity';
import { UI_TIMINGS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { useCodeDrawerStore } from '@/lib/stores/code-drawer-store';
import { extractCodeExplainContext } from '@/lib/code-viewport/explain-context';
import { useClipboard } from '@/hooks/useClipboard';
import * as m from '@/paraglide/messages';

interface CodeGroupProps {
 children: React.ReactNode;
}

function extractCodeTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractCodeTextContent).join('');
  if (React.isValidElement<{ children?: React.ReactNode; 'data-code'?: string }>(node)) {
    if (typeof node.props['data-code'] === 'string') return node.props['data-code'];
    if (node.props.children !== undefined) return extractCodeTextContent(node.props.children);
  }
  return '';
}

export default function CodeGroup({ children }: CodeGroupProps) {
 const [activeIdx, setActiveIdx] = useState(0);
 const [deepDiveSent, setDeepDiveSent] = useState(false);
 const containerRef = useRef<HTMLDivElement | null>(null);

 const childrenArray = React.Children.toArray(children);
 
 if (childrenArray.length === 0) {
 return null;
 }

 // Extract clean titles and languages for tabs
 const tabs = childrenArray.map((child: any, idx: number) => {
 let title = child?.props?.title || child?.props?.filename || child?.props?.name || `Tab ${idx + 1}`;
 let language = child?.props?.language || child?.props?.lang || 'text';
 
 // Fallback: check inner code block props if wrapped in pre/code/SandboxPre
 if (child?.props?.children?.props) {
 const innerProps = child.props.children.props;
 title = innerProps.title || innerProps.filename || title;
 language = innerProps['data-language'] || innerProps.language || innerProps.lang || language;
 }
 
 return { title, language };
 });

 const activeChild: any = childrenArray[activeIdx] || childrenArray[0];
 
 // Extract active code text
 let activeCodeText = '';
 if (typeof activeChild?.props?.children === 'string') {
 activeCodeText = activeChild.props.children;
 } else if (typeof activeChild?.props?.children?.props?.['data-code'] === 'string') {
 activeCodeText = activeChild.props.children.props['data-code'];
 } else if (typeof activeChild?.props?.children?.props?.children === 'string') {
 activeCodeText = activeChild.props.children.props.children;
 } else if (typeof activeChild?.props?.raw === 'string') {
 activeCodeText = activeChild.props.raw;
 } else if (activeChild?.props?.children !== undefined) {
 activeCodeText = extractCodeTextContent(activeChild.props.children);
 }

 const activeLang = tabs[activeIdx]?.language || 'text';
 const complexityScore = scoreCodeComplexity(activeCodeText, activeLang);
 const shouldShowDissection = complexityScore >= 15;

 const { copy, isCopied } = useClipboard({ timeout: UI_TIMINGS.COPY_FEEDBACK });

 const handleTabClick = (idx: number, tabTitle: string) => {
 setActiveIdx(idx);
 };

 const handleCopy = () => {
 if (activeCodeText) {
 copy(activeCodeText, 'code');
 }
 };

 const handleDeepDive = () => {
    if (!activeCodeText) return;
    const activeTabTitle = tabs[activeIdx]?.title;
    const drawerState = useCodeDrawerStore.getState();
    const context = extractCodeExplainContext({
      element: containerRef.current,
      code: activeCodeText,
      language: activeLang,
      title: activeTabTitle,
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
    setTimeout(() => setDeepDiveSent(false), UI_TIMINGS.COPY_FEEDBACK);
  };

  return (
    <CodeGroupProvider>
      <div
        ref={containerRef}
        className="group relative rounded-xl border border-theme-border/60 bg-theme-surface my-6 shadow-2xs overflow-hidden text-xs font-mono transition-colors"
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-3.5 py-2 border-b border-theme-border/40 select-none overflow-x-auto no-scrollbar bg-theme-surface/60 backdrop-blur-xs">
          {/* Left Tabs */}
          <div className="flex items-center gap-1 min-w-0">
            {tabs.map((tab, idx) => {
              const isActive = idx === activeIdx;
              return (
                <button
                  key={idx}
                  onClick={() => handleTabClick(idx, tab.title)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-caption font-medium transition-all shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-theme-bg text-theme-foreground shadow-2xs border border-theme-border/70'
                      : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-primary/5'
                  }`}
                >
                  <FileCode size={13} className={isActive ? 'text-theme-primary' : 'text-theme-muted'} />
                  <span>{tab.title}</span>
                </button>
              );
            })}
          </div>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-1.5 shrink-0 pl-2">
            {shouldShowDissection && (
              <button
                type="button"
                onClick={handleDeepDive}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-caption font-medium bg-theme-primary/10 text-theme-primary hover:bg-theme-primary/20 transition-all cursor-pointer active:scale-95"
                title={m.code_ai_explain()}
              >
                {deepDiveSent ? <Check size={12} /> : <Sparkles size={12} />}
                <span>{m.code_ai_explain()}</span>
              </button>
            )}

            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-caption font-medium text-theme-muted hover:text-theme-foreground hover:bg-theme-primary/5 active:scale-95 transition-all cursor-pointer"
              title={m.common_copy()}
            >
              {isCopied('code') ? (
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

 {/* Code Content View */}
 <div className="relative overflow-x-auto px-3.5 py-3.5 leading-relaxed font-mono">
 {activeChild}
 </div>
 </div>
 </CodeGroupProvider>
 );
}

export function CodeGroupItem({ children }: { children: React.ReactNode; title?: string }) {
 return <>{children}</>;
}

CodeGroup.Item = CodeGroupItem;
