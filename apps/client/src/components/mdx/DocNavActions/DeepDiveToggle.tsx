'use client';
import * as m from '@/paraglide/messages';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';

import { DEEP_DIVE_BLOCK_SELECTOR, STORAGE_KEYS } from '@/lib/constants';

export function readDeepDivePreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEYS.READER_DEEP_DIVE_OPEN) === '1';
  } catch {
    return false;
  }
}

export function applyDeepDiveOpenState(next: boolean, root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLDetailsElement>(`details[${DEEP_DIVE_BLOCK_SELECTOR}]`)
    .forEach((block) => {
      block.open = next;
    });
}

export function DeepDiveToggle({ count, docKey }: { count: number; docKey?: string }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);

  const apply = useCallback((next: boolean) => {
    applyDeepDiveOpenState(next);
  }, []);

  const commit = useCallback(
    (next: boolean) => {
      openRef.current = next;
      setOpen(next);
      apply(next);
      try {
        window.localStorage.setItem(STORAGE_KEYS.READER_DEEP_DIVE_OPEN, next ? '1' : '0');
      } catch {
      }
    },
    [apply],
  );

  useEffect(() => {
    const saved = readDeepDivePreference();
    openRef.current = saved;
    setOpen(saved);
    apply(saved);
  }, [apply, count, docKey]);

  useEffect(() => {
    const beforePrint = () => apply(true);
    const afterPrint = () => apply(openRef.current);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [apply]);

  return (
    <button
      type="button"
      onClick={() => commit(!open)}
      aria-pressed={open}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-serif border transition-all cursor-pointer ${
        open
          ? 'bg-theme-primary/10 border-theme-primary/40 text-theme-primary'
          : 'border-transparent text-theme-muted hover:text-theme-foreground hover:border-theme-border'
      }`}
      title={open ? m.reader_deep_dive_hide_title() : m.reader_deep_dive_show_title({ count })}
    >
      <BookOpen className="w-3.5 h-3.5" />
      {open ? m.reader_deep_dive_hide() : m.reader_deep_dive_show()}
    </button>
  );
}
