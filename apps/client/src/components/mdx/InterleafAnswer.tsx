'use client';

import React, { useState, useRef, useEffect } from 'react';
import * as m from '@/paraglide/messages';

export interface InterleafAnswerProps {
  children: React.ReactNode;
}

export function InterleafAnswer({ children }: InterleafAnswerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(0);

  useEffect(() => {
    if (isOpen && contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    } else {
      setHeight(0);
    }
  }, [isOpen]);

  return (
    <div className="my-8">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group w-full py-3 flex items-center border-b border-dashed border-theme-border hover:border-theme-primary/50 transition-colors duration-500 ease-out focus:outline-none"
      >
        <span 
          className={`inline-block transition-transform duration-500 ease-out text-theme-muted ${isOpen ? 'rotate-90' : 'rotate-0'}`}
        >
          ▸
        </span>
        <span className="ml-3 text-theme-muted font-serif text-caption tracking-wide italic group-hover:text-theme-foreground transition-colors duration-500">
          {isOpen ? m.interleaf_collapse() : m.interleaf_expand()}
        </span>
      </button>

      <div 
        className="overflow-hidden transition-all duration-500 ease-out"
        style={{ height: isOpen ? height : 0, opacity: isOpen ? 1 : 0 }}
      >
        <div ref={contentRef} className="pt-5 pb-3">
          <div className="pl-4 ml-1.5 border-l-2 border-theme-border/60 relative before:absolute before:-top-2 before:-left-[1px] before:w-[2px] before:h-2 before:bg-theme-border/60 after:absolute after:-bottom-2 after:-left-[1px] after:w-[2px] after:h-2 after:bg-theme-border/60">
            <div className="text-theme-foreground/90 font-sans text-caption leading-loose prose dark:prose-invert prose-sm max-w-none">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
