'use client';

import React from 'react';
import {
  GraduationCap,
  Microscope,
  ListChecks,
  BookMarked,
} from 'lucide-react';
import { TRANSCRIPTION_PRESETS } from '@/lib/transcription-presets';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { useImportWizard } from '../ImportWizardContext';
import * as m from '@/paraglide/messages';

const PRESET_ICONS: Record<string, React.ReactNode> = {
  standard: <GraduationCap size={13} className="shrink-0 text-sky-600 dark:text-sky-400" />,
  deep: <Microscope size={13} className="shrink-0 text-violet-600 dark:text-violet-400" />,
  cheatsheet: <ListChecks size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />,
  faithful: <BookMarked size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />,
};

const CORE_STYLE_IDS = new Set(['standard', 'deep', 'cheatsheet']);

export function WorkbenchTranscriptionSettings() {
  const transcriptionPreset = useImportWizardStore((s) => s.transcriptionPreset);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const { applyTranscriptionPreset } = useImportWizard();

  const isTextOnlyRepo = (scoutData as any)?.profile?.ingestMode === 'text_only';
  const visiblePresets = TRANSCRIPTION_PRESETS.filter(
    (preset) =>
      CORE_STYLE_IDS.has(preset.id) ||
      (preset.id === 'faithful' && (isTextOnlyRepo || transcriptionPreset === 'faithful')),
  );

  return (
    <div
      role="radiogroup"
      aria-label={m.workbench_style_prefix()}
      className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-theme-bg/70 border border-theme-border/60 select-none"
    >
      <span className="pl-2 pr-1.5 text-xs font-serif text-theme-muted shrink-0">
        {m.workbench_style_prefix()}
      </span>
      <div className="h-3.5 w-px bg-theme-border/60 mr-0.5 shrink-0" />
      {visiblePresets.map((preset) => {
        const isActive = transcriptionPreset === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => applyTranscriptionPreset(preset.id)}
            title={preset.description}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-serif transition-all cursor-pointer ${
              isActive
                ? 'bg-theme-primary/15 text-theme-primary border border-theme-primary/40 font-bold shadow-2xs'
                : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/70 border border-transparent'
            }`}
          >
            {PRESET_ICONS[preset.id]}
            <span>{preset.name}</span>
          </button>
        );
      })}
    </div>
  );
}
