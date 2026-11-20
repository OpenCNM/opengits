'use client';

import { useImportWizardStore } from '@/lib/stores/import-wizard-store';

import { EditorHeaderBar } from './editor/EditorHeaderBar';
import { WorkbenchMetadataBar } from './editor/WorkbenchMetadataBar';
import { OutlineCategoryBlock, type WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import { ExcludedFilesPanel } from './editor/ExcludedFilesPanel';

interface WorkbenchOutlineEditorProps {
  canUndoReorganize?: boolean;
  onUndoReorganize?: () => void;
}

/**
 * 大纲编排预览器（只读结构视图 + 撤回入口）：
 * AI 重新编排控制组已下沉至底部决策栏，释放大纲纵向可视空间。
 */
export function WorkbenchOutlineEditor({
  canUndoReorganize = false,
  onUndoReorganize,
}: WorkbenchOutlineEditorProps) {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const translatingIndices = useImportWizardStore((s) => s.translatingIndices);

  return (
    <div className="flex flex-col bg-theme-bg border border-theme-border/80 rounded-xl p-4.5 shadow-xs overflow-hidden flex-1 min-h-0">
      {/* Outline Top Header Bar */}
      <EditorHeaderBar
        chapterCount={customOutline.length}
        canUndoReorganize={canUndoReorganize}
        onUndoReorganize={onUndoReorganize}
      />

      {/* Domain & Technical Tags Metadata Bar */}
      <WorkbenchMetadataBar />

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
