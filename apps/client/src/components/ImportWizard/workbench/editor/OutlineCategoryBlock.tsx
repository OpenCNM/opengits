'use client';

import { stripPhaseSuffix } from '@/engine/tree-batch-utils';
import type { WorkbenchOutlineFile } from './OutlineFileRow';

/** 大纲章节的最小结构（store 中 customOutline 为 any[]，此处做结构性收窄） */
export interface WorkbenchOutlineCategory {
  name: string;
  title?: string;
  partTitle?: string;
  files?: WorkbenchOutlineFile[];
}

interface OutlineCategoryBlockProps {
  cat: WorkbenchOutlineCategory;
  catIndex: number;
  /** AI 翻译中的大纲条目索引集合（`name-{i}`） */
  translatingIndices: Set<string>;
}

export function OutlineCategoryBlock({
  cat,
  catIndex,
  translatingIndices,
}: OutlineCategoryBlockProps) {
  const isTranslatingCatName = translatingIndices.has(`name-${catIndex}`);
  const rawTitle = cat.title || cat.name || '';
  const categoryTitle = stripPhaseSuffix(rawTitle);

  return (
    <div className="border border-theme-border/80 rounded-xl bg-theme-bg overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-3 bg-theme-surface/50">
        <span
          className={`font-serif font-bold text-xs flex-1 truncate ${
            isTranslatingCatName ? 'animate-pulse text-theme-primary' : 'text-theme-foreground'
          }`}
        >
          {categoryTitle}
        </span>
      </div>
    </div>
  );
}
