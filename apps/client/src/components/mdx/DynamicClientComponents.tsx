'use client';

import dynamic from 'next/dynamic';

const MermaidLoading = () => (
  <div className="my-8 p-6 bg-theme-surface border border-theme-border/80 rounded-2xl">
    <div className="text-xs text-theme-muted animate-pulse py-4 text-center">…</div>
  </div>
);

export const Mermaid = dynamic(() => import('./Mermaid'), {
  ssr: false,
  loading: MermaidLoading,
});
