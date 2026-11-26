'use client';

import React from 'react';
import { Info, Lightbulb, CheckCircle2, AlertTriangle, AlertOctagon, Zap } from 'lucide-react';

export type CalloutType = 'info' | 'note' | 'tip' | 'check' | 'important' | 'warning' | 'danger';

interface CalloutProps {
 type?: CalloutType;
 title?: string;
 children: React.ReactNode;
}

const config = {
 info: {
 icon: Info,
 bg: 'bg-theme-bg/50',
 border: 'border-theme-primary/25 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-theme-primary',
 },
 note: {
 icon: Info,
 bg: 'bg-theme-bg/70',
 border: 'border-theme-border/60 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-theme-muted',
 },
 tip: {
 icon: Lightbulb,
 bg: 'bg-emerald-900/5',
 border: 'border-emerald-700/20 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-emerald-700',
 },
 check: {
 icon: CheckCircle2,
 bg: 'bg-emerald-900/5',
 border: 'border-emerald-700/20 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-emerald-700',
 },
 important: {
 icon: Zap,
 bg: 'bg-violet-900/5',
 border: 'border-violet-700/20 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-violet-700',
 },
 warning: {
 icon: AlertTriangle,
 bg: 'bg-theme-bg/60',
 border: 'border-theme-primary/30 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-theme-primary',
 },
 danger: {
 icon: AlertOctagon,
 bg: 'bg-theme-accent/5',
 border: 'border-theme-accent/20 shadow-2xs',
 text: 'text-theme-foreground/85',
 iconColor: 'text-theme-accent',
 },
};

export default function Callout({ type = 'info', title, children }: CalloutProps) {
 const cfg = config[type] || config.info;
 const IconComponent = cfg.icon;

 return (
 <div className={`my-8 flex gap-4 p-5 rounded-2xl border backdrop-blur-xl transition-all duration-300 hover:shadow-md ${cfg.bg} ${cfg.border}`}>
 <div className={`flex-shrink-0 mt-0.5 ${cfg.iconColor}`}>
 <IconComponent size={20} className="animate-pulse-subtle" />
 </div>
 <div className={`flex-1 min-w-0 text-sm ${cfg.text}`}>
 {title && (
 <h5 className="font-semibold mb-2 text-theme-foreground text-base">
 {title}
 </h5>
 )}
 <div className="prose-sm max-w-none prose-p:leading-relaxed prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-li:my-1 prose-pre:my-3">{children}</div>
 </div>
 </div>
 );
}
