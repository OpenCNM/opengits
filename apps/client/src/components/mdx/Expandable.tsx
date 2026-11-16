'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

interface ExpandableProps {
 title: string;
 subtitle?: string;
 children: React.ReactNode;
 defaultOpen?: boolean;
}

export default function Expandable({ title, subtitle, children, defaultOpen = false }: ExpandableProps) {
 const [isOpen, setIsOpen] = useState(defaultOpen);

 return (
 <div className="my-8 rounded-2xl border border-theme-border/80 bg-theme-surface/80 backdrop-blur-xl shadow-md hover:shadow-lg hover:border-theme-primary/30 transition-all duration-300 overflow-hidden group">
 <button
 onClick={() => setIsOpen(!isOpen)}
 className="w-full flex items-center justify-between p-5 text-left hover:bg-theme-bg/60 transition-colors focus:outline-none cursor-pointer"
 >
 <div className="min-w-0 pr-4">
 <span className="font-mono text-sm font-semibold text-theme-foreground block truncate group-hover:text-theme-primary transition-colors">
 {title}
 </span>
 {subtitle && (
 <span className="text-xs text-theme-muted font-sans block mt-1 truncate">
 {subtitle}
 </span>
 )}
 </div>
 <motion.div
 animate={{ rotate: isOpen ? 180 : 0 }}
 transition={{ duration: 0.25, ease: 'easeInOut' }}
 className="flex-shrink-0 p-1.5 rounded-full bg-theme-bg border border-theme-border text-theme-muted group-hover:bg-theme-primary/10 group-hover:text-theme-primary transition-colors"
 >
 <ChevronDown size={15} />
 </motion.div>
 </button>

 <AnimatePresence initial={false}>
 {isOpen && (
 <motion.div
 initial={{ height: 0, opacity: 0 }}
 animate={{ height: 'auto', opacity: 1 }}
 exit={{ height: 0, opacity: 0 }}
 transition={{ duration: 0.25, ease: [0.04, 0.62, 0.23, 0.98] }}
 >
 <div className="p-4.5 pt-0 border-t border-theme-border bg-theme-bg/30 ">
 <div className="pl-4 border-l-2 border-theme-primary/30 space-y-3 mt-4 text-sm text-theme-foreground font-sans">
 {children}
 </div>
 </div>
 </motion.div>
 )}
 </AnimatePresence>
 </div>
 );
}
