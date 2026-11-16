'use client';

import React, { useState } from 'react';
import {
  Sliders,
  Sparkles,
  Check,
  ChevronDown,
  GraduationCap,
  Microscope,
  ListChecks,
  BookMarked,
  ArrowLeftRight,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { TRANSCRIPTION_PRESETS, resolveTranscriptionPreset } from '@/lib/transcription-presets';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import { useImportWizard } from '../ImportWizardContext';
import * as m from '@/paraglide/messages';

const PRESET_ICONS: Record<string, React.ReactNode> = {
  standard: <GraduationCap size={15} className="shrink-0 text-sky-600 dark:text-sky-400" />,
  deep: <Microscope size={15} className="shrink-0 text-violet-600 dark:text-violet-400" />,
  cheatsheet: <ListChecks size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />,
  faithful: <BookMarked size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />,
  analogy: <ArrowLeftRight size={15} className="shrink-0 text-rose-600 dark:text-rose-400" />,
};

export function WorkbenchTranscriptionSettings() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const transcriptionPreset = useImportWizardStore((s) => s.transcriptionPreset);
  const createEdition = useImportWizardStore((s) => s.createEdition);
  const editionLabel = useImportWizardStore((s) => s.editionLabel);
  const repoPreExisted = useImportWizardStore((s) => s.repoPreExisted);

  const { setCreateEdition, setEditionLabel } = wizardSetters;
  const { applyTranscriptionPreset } = useImportWizard();

  const currentPreset = resolveTranscriptionPreset(transcriptionPreset);
  const isFaithful = transcriptionPreset === 'faithful';

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-theme-border/70 bg-theme-bg hover:border-theme-primary/60 text-xs font-serif text-theme-foreground transition-all cursor-pointer shadow-2xs select-none"
      >
        <Sliders size={13} className="text-theme-primary shrink-0" />
        <span className="text-theme-muted">{m.workbench_edition_label()}</span>
        <span className="font-bold text-theme-foreground">{currentPreset.name}</span>
        {isFaithful ? (
          <span className="text-micro px-1.5 py-0.2 rounded-full bg-theme-surface text-theme-muted border border-theme-border/60 font-mono">
            {m.workbench_edition_original()}
          </span>
        ) : (
          <span className="text-micro px-1.5 py-0.2 rounded-full bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-mono font-medium">
            {m.workbench_edition_ai()}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-3 bg-theme-bg border border-theme-border rounded-2xl shadow-xl space-y-2.5 text-xs text-left select-none z-[300]"
      >
        <div className="flex items-center justify-between pb-1.5 border-b border-theme-border/50">
          <div className="flex items-center gap-1.5 font-serif font-bold text-theme-foreground">
            <Sparkles size={13} className="text-theme-primary" />
            <span>{m.workbench_edition_style_title()}</span>
          </div>
          <span className="text-micro text-theme-muted font-sans">{m.workbench_edition_click_to_switch()}</span>
        </div>

        {/* 核心文风单选列表（极简单列，一眼扫过即懂） */}
        <div className="space-y-1">
          {TRANSCRIPTION_PRESETS.map((preset) => {
            const isActive = transcriptionPreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyTranscriptionPreset(preset.id)}
                className={`w-full p-2 text-left rounded-xl border transition-all flex items-start gap-2.5 cursor-pointer ${
                  isActive
                    ? 'border-theme-primary/80 bg-theme-primary/10 text-theme-primary font-bold shadow-2xs'
                    : 'border-transparent hover:bg-theme-surface/70 text-theme-muted hover:text-theme-foreground'
                }`}
              >
                <div className="mt-0.5">{PRESET_ICONS[preset.id] || <Sparkles size={14} />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-serif leading-tight">{preset.name}</span>
                    {isActive && <Check size={12} className="text-theme-primary shrink-0" />}
                  </div>
                  <p className="text-micro text-theme-muted/80 mt-0.5 leading-snug line-clamp-1 font-normal">
                    {preset.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* 高级选项（独立新版本）：默认折叠收纳，0 认知噪音 */}
        <div className="pt-1.5 border-t border-theme-border/40">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-full flex items-center justify-between py-1 px-1 text-micro text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
          >
            <span>{m.workbench_edition_advanced()}</span>
            <ChevronDown size={12} className={`transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
          </button>

          {showAdvanced && (
            <div className="pt-2 space-y-2 animate-in fade-in duration-200">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-serif font-medium text-theme-foreground block text-micro">
                    {m.workbench_editor_create_edition_label()}
                  </span>
                  <p className="text-micro text-theme-muted leading-tight mt-0.5">
                    {repoPreExisted || createEdition
                      ? m.workbench_editor_create_edition_desc_on()
                      : m.workbench_editor_create_edition_desc_off()}
                  </p>
                </div>
                <Switch
                  checked={repoPreExisted || createEdition}
                  disabled={repoPreExisted}
                  onCheckedChange={setCreateEdition}
                  aria-label={m.workbench_editor_create_edition_label()}
                />
              </div>

              {(repoPreExisted || createEdition) && (
                <div className="pt-1 space-y-1">
                  <input
                    type="text"
                    value={editionLabel}
                    onChange={(e) => setEditionLabel(e.target.value)}
                    placeholder={m.workbench_editor_edition_label_placeholder()}
                    maxLength={50}
                    className="w-full text-xs font-sans bg-theme-bg border border-theme-border/70 rounded-lg px-2.5 py-1.5 outline-none focus:border-theme-primary text-theme-foreground"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
