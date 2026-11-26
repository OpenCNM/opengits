import React from 'react';
import Link from 'next/link';
import * as m from '@/paraglide/messages';

export interface ChapterAsset {
  path: string;
  type: string;
  downloadUrl?: string;
}

interface ChapterFoldoutProps {
  assets?: ChapterAsset[];
}

export function ChapterFoldout({ assets }: ChapterFoldoutProps) {
  if (!assets || assets.length === 0) {
    return null;
  }

  if (assets.length < 3) {
    return (
      <div className="mt-12 pt-4 border-t border-theme-border/60 text-caption font-sans text-theme-muted flex gap-4">
        <span className="tracking-widest">{m.common_appendix()}</span>
        {assets.map((asset, idx) => {
          const filename = asset.path.split('/').pop() || asset.path;
          return (
            <Link 
              key={idx} 
              href={asset.downloadUrl || asset.path}
              className="hover:text-theme-foreground transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              {filename}
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mt-12 bg-theme-surface border-t border-theme-border/60 p-6 sm:p-8 rounded-sm shadow-sm transition-all duration-300 hover:shadow-md">
      <h3 className="text-theme-muted text-compact tracking-widest uppercase mb-4 font-serif">
        {m.chapter_resources()}
      </h3>
      <ul className="space-y-3">
        {assets.map((asset, idx) => {
          const filename = asset.path.split('/').pop() || asset.path;
          return (
            <li key={idx} className="font-sans text-xs text-theme-muted flex items-center group">
              <span className="w-1 h-1 rounded-full bg-theme-border mr-3 group-hover:bg-theme-primary/60 transition-colors duration-300"></span>
              <Link 
                href={asset.downloadUrl || asset.path}
                className="hover:text-theme-foreground transition-colors duration-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                {filename}
              </Link>
              {asset.type && (
                <span className="ml-3 text-compact text-theme-muted/80 uppercase border border-theme-border/60 px-1.5 py-0.5 rounded-sm bg-theme-bg group-hover:border-theme-border transition-colors duration-300">
                  {asset.type}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
