'use client';

import { useState } from 'react';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';

import { EditorHeaderBar } from './editor/EditorHeaderBar';
import { WorkbenchMetadataBar } from './editor/WorkbenchMetadataBar';
import { OutlineCategoryBlock, type WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import { ExcludedFilesPanel } from './editor/ExcludedFilesPanel';
import { WorkbenchReorganizePanel, type LearnerArchetype } from './WorkbenchReorganizePanel';

interface WorkbenchOutlineEditorProps {
  onReorganize?: (options: {
    customPrompt: string;
    pacing: 'compact' | 'normal' | 'detailed';
    learnerArchetype?: LearnerArchetype;
  }) => void;
}

/**
 * 大纲编排预览器（只读视图 + AI 重新编排入口）：
 * 去除手动编辑、删除、拖拽排序与鼠标交互，仅保留结构预览与 AI 重新编排。
 */
export function WorkbenchOutlineEditor({ onReorganize }: WorkbenchOutlineEditorProps) {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const translatingIndices = useImportWizardStore((s) => s.translatingIndices);
  const [isReorganizeOpen, setIsReorganizeOpen] = useState(false);

  return (
    <div className="flex flex-col bg-theme-bg border border-theme-border/80 rounded-xl p-4.5 shadow-xs overflow-hidden flex-1 min-h-0">
      {/* Outline Top Header Bar */}
      <EditorHeaderBar
        chapterCount={customOutline.length}
        onOpenReorganize={() => setIsReorganizeOpen((prev) => !prev)}
        isReorganizeOpen={isReorganizeOpen}
      />

      {/* Domain & Technical Tags Metadata Bar */}
      <WorkbenchMetadataBar />

      {/* AI 重新编排内嵌面板：不遮挡大纲，用户对照下方章节直接选择调整意向 */}
      {isReorganizeOpen && (
        <WorkbenchReorganizePanel
          onClose={() => setIsReorganizeOpen(false)}
          onReorganize={onReorganize}
        />
      )}

      {/* Outline Tree Scrollable Container */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1.5 space-y-2.5">
        {customOutline.map((cat: WorkbenchOutlineCategory, catIndex: number) => {
          const prevCat = catIndex > 0 ? (customOutline[catIndex - 1] as WorkbenchOutlineCategory) : null;
          const showPartDivider = !!cat.partTitle && (!prevCat || prevCat.partTitle !== cat.partTitle);
          return (
            <div key={`cat-group-${catIndex}`} className="space-y-2.5">
              {showPartDivider && (
                <div className="flex items-center gap-2 pt-2 pb-1 px-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-theme-primary">
                    {cat.partTitle}
                  </span>
                  <div className="flex-1 h-px bg-theme-border/60" />
                </div>
              )}
              <OutlineCategoryBlock
                key={`cat-${catIndex}`}
                cat={cat}
                catIndex={catIndex}
                translatingIndices={translatingIndices}
              />
            </div>
          );
        })}
      </div>

      {/* 安全出口：LLM 编排自动过滤的辅助/答案文件 */}
      <ExcludedFilesPanel />
    </div>
  );
}
