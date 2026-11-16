'use client';

import { ShieldCheck } from 'lucide-react';
import { useWorkbenchExcludedFiles } from '../../hooks/useWorkbenchExcludedFiles';
import * as m from '@/paraglide/messages';

/** 安全出口面板：LLM 编排自动过滤的辅助/答案文件，可查看与恢复（空列表不渲染） */
export function ExcludedFilesPanel() {
  const {
    outlineExcluded,
    excludedPanelOpen,
    setExcludedPanelOpen,
    excludedChecked,
    toggleExcludedChecked,
    handleRestoreCheckedFiles,
  } = useWorkbenchExcludedFiles();

  if (outlineExcluded.length === 0) return null;

  return (
    <div className="border border-dashed border-theme-border/70 rounded-xl bg-theme-bg/40 mt-2 shrink-0">
      <button
        type="button"
        onClick={() => setExcludedPanelOpen(!excludedPanelOpen)}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left cursor-pointer"
      >
        <span className="flex items-center gap-2 text-xs text-theme-muted font-sans">
          <ShieldCheck size={13} className="text-theme-primary/70 shrink-0" />
          <span>
            {m.workbench_editor_excluded_summary({ count: outlineExcluded.length })}
            <span className="text-theme-muted/70">
              {m.workbench_editor_excluded_reasons({
                reasons: [...new Set(outlineExcluded.map((f) => f.reason))].join(' · '),
              })}
            </span>
          </span>
        </span>
        <span className="text-micro font-sans text-theme-primary shrink-0">
          {excludedPanelOpen ? m.common_collapse() : m.workbench_editor_view_and_restore()}
        </span>
      </button>
      {excludedPanelOpen && (
        <div className="px-3.5 pb-3 flex flex-col gap-1.5 max-h-44 overflow-y-auto custom-scrollbar">
          {outlineExcluded.map((f) => (
            <label
              key={f.path}
              className="flex items-center gap-2.5 text-micro font-sans text-theme-muted cursor-pointer rounded-lg px-2 py-1.5 hover:bg-theme-surface/70 border border-transparent hover:border-theme-border/40 transition-all"
            >
              <input
                type="checkbox"
                checked={excludedChecked.has(f.path)}
                onChange={() => toggleExcludedChecked(f.path)}
                className="accent-theme-primary cursor-pointer"
              />
              <span className="font-mono truncate flex-1" title={f.note || ''}>
                {f.path}
              </span>
              <span className="shrink-0 text-micro px-1.5 py-0.5 rounded bg-theme-border/40 text-theme-muted">
                {f.reason}
              </span>
            </label>
          ))}
          {excludedChecked.size > 0 && (
            <button
              type="button"
              onClick={handleRestoreCheckedFiles}
              className="self-end text-micro font-sans font-medium px-3 py-1.5 rounded-lg bg-theme-primary text-theme-bg cursor-pointer hover:opacity-90 transition-opacity"
            >
              {m.workbench_editor_restore_checked({ count: excludedChecked.size })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
