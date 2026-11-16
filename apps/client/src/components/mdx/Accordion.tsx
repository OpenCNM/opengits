'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

interface AccordionGroupProps {
 children: React.ReactNode;
}

export function AccordionGroup({ children }: AccordionGroupProps) {
 return (
 <div className="my-8 flex flex-col gap-2 w-full">
 {children}
 </div>
 );
}

interface AccordionProps {
 title: string;
 children: React.ReactNode;
 defaultOpen?: boolean;
}

export function Accordion({ title, children, defaultOpen = false }: AccordionProps) {
 const [isOpen, setIsOpen] = useState(defaultOpen);

 return (
 <div className="overflow-hidden group">
 <button
 onClick={() => setIsOpen(!isOpen)}
 data-state={isOpen ? "open" : "closed"}
 className="theme-primary"
 >
 <span className="truncate">{title}</span>
 <span className="theme-primary">
 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
 <path d="M12 5v14M5 12h14"/>
 </svg>
 </span>
 </button>

 <AnimatePresence initial={false}>
 {isOpen && (
 <motion.div
 initial={{ height: 0, opacity: 0 }}
 animate={{ height: 'auto', opacity: 1 }}
 exit={{ height: 0, opacity: 0 }}
 transition={{ duration: 0.25, ease: [0.04, 0.62, 0.23, 0.98] }}
 >
 <div className="theme-primary">
 <div className="space-y-3 mt-2">
 {children}
 </div>
 </div>
 </motion.div>
 )}
 </AnimatePresence>
 </div>
 );
}
