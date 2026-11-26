'use client';

import React from 'react';

interface StepsProps {
 children: React.ReactNode;
}

export function Steps({ children }: StepsProps) {
 return (
 <div className="my-8 pl-4 relative before:content-[''] before:absolute before:left-[27px] before:top-2 before:bottom-2 before:w-0.5 before:bg-theme-bg space-y-8 before:z-0">
 {children}
 </div>
 );
}

interface StepProps {
 title?: string;
 children: React.ReactNode;
}

export function Step({ title, children }: StepProps) {
 return (
 <div className="relative pl-8 group z-10">
 <div className="absolute left-0 top-0.5 w-6 h-6 rounded-full border-2 border-theme-primary/30 bg-theme-bg flex items-center justify-center transition-all duration-300 group-hover:scale-110 group-hover:bg-theme-primary/10 z-10">
 <div className="w-1.5 h-1.5 rounded-full bg-theme-primary/10" />
 </div>

 {title && (
 <h4 className="text-sm font-semibold text-theme-foreground m-0 mb-2 leading-none group-hover:text-theme-primary transition-colors">
 {title}
 </h4>
 )}

 <div className="text-sm text-theme-foreground prose-sm max-w-none">
 {children}
 </div>
 </div>
 );
}
