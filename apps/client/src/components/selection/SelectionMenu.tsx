'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore } from '@/lib/stores/modal-store';
import * as m from '@/paraglide/messages';

interface SelectionState {
  text: string;
  top: number;
  bottom: number;
  left: number;
  width: number;
  range: Range;
}

export default function SelectionMenu() {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [mounted, setMounted] = useState(false);

  // Initialize on client side only
  useEffect(() => {
    setMounted(true);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleSelection = (e?: Event) => {
      if (e && e.target && (e.target as HTMLElement).closest && (e.target as HTMLElement).closest('#selection-menu-wrapper')) {
        return;
      }

      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          const range = sel.getRangeAt(0);

          const docContentArea = document.getElementById('doc-content-area');
          if (!docContentArea || !docContentArea.contains(range.commonAncestorContainer)) {
            setSelection(null);
            return;
          }

          const rect = range.getBoundingClientRect();

          setSelection({
            text: sel.toString(),
            top: rect.top + window.scrollY,
            bottom: rect.bottom + window.scrollY,
            left: rect.left + window.scrollX + rect.width / 2,
            width: rect.width,
            range: range.cloneRange()
          });
        } else {
          if (!document.activeElement || !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            setSelection(null);
          }
        }
      }, 150);
    };

    document.addEventListener('selectionchange', handleSelection);
    return () => {
      document.removeEventListener('selectionchange', handleSelection);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  if (!mounted || !selection) return null;

  const menuWidth = 120;
  const menuHeight = 44;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const scrollX = typeof window !== 'undefined' ? window.scrollX : 0;
  const minLeft = scrollX + menuWidth / 2 + 10;
  const maxLeft = scrollX + viewportWidth - menuWidth / 2 - 10;
  let anchorLeft = Math.max(minLeft, Math.min(maxLeft, selection.left));

  let anchorTop = selection.top - menuHeight - 12;
  let transformOrigin = 'bottom center';

  if (anchorTop < window.scrollY + 10) {
    anchorTop = selection.bottom + 12;
    transformOrigin = 'top center';
  }

  const menu = (
    <div
      id="selection-menu-wrapper"
      style={{ top: anchorTop, left: anchorLeft, transform: 'translateX(-50%)' }}
      className="absolute z-[9999] flex flex-col items-center"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        style={{ transformOrigin }}
        className="bg-theme-surface/95 backdrop-blur-2xl shadow-xl border border-theme-border transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] animate-in fade-in zoom-in-95 overflow-hidden rounded-xl flex items-center justify-between w-[120px] h-[44px] px-3 py-1.5"
      >
        <button
          className="flex-1 text-xs font-semibold text-theme-foreground hover:text-theme-primary transition-colors text-center py-1"
          onClick={() => {
            useModalStore.getState().openAskAi(selection.text);
            setSelection(null);
          }}
        >
          {m.code_ai_explain()}
        </button>
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
