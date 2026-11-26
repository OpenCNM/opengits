'use client';

import React from 'react';
import { Sparkles, HelpCircle, CheckCircle2 } from 'lucide-react';
import * as m from '@/paraglide/messages';

interface SummaryProps {
 title?: string;
 children: React.ReactNode;
}

export default function Summary({ title, children }: SummaryProps) {
 const resolvedTitle = title ?? m.chapter_summary();
 return (
 <div className="my-8 p-6 rounded-2xl border-2 border-dashed border-theme-border bg-theme-bg/50 backdrop-blur-sm relative overflow-hidden">
 <div className="absolute -right-20 -top-20 w-40 h-40 bg-theme-primary/10/5 rounded-full blur-3xl pointer-events-none" />

 <div className="flex items-center gap-2 mb-4">
 <div className="w-7 h-7 flex items-center justify-center rounded-lg bg-theme-primary/10 text-theme-primary ">
 <Sparkles size={16} />
 </div>
 <span className="text-sm font-semibold uppercase tracking-wider text-theme-primary leading-none">
 {resolvedTitle}
 </span>
 </div>

 <div className="prose prose-sm max-w-none text-theme-foreground [&>ul]:list-none [&>ul]:pl-0 [&>ul>li]:relative [&>ul>li]:pl-6 [&>ul>li::before]:content-[''] [&>ul>li::before]:absolute [&>ul>li::before]:left-0 [&>ul>li::before]:top-[5px] [&>ul>li::before]:w-2 [&>ul>li::before]:h-2 [&>ul>li::before]:rounded-full [&>ul>li::before]:bg-theme-primary/10 [&>ol]:pl-4">
 {children}
 </div>
 </div>
 );
}
