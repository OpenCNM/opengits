'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';

export type LearnerArchetype =
  | 'architecture_overview'
  | 'deep_dive_internals'
  | 'cross_language_migrant'
  | 'pedagogical_beginner';

export type ReorganizeMotive = 'reroll' | 'untangle' | 'compact' | 'detailed';

interface MotiveConfig {
  id: ReorganizeMotive;
  icon: string;
  label: string;
  sub: string;
  pacing: 'compact' | 'normal' | 'detailed';
  learnerArchetype: LearnerArchetype;
  basePrompt: string;
}

function getReorganizeMotives(): MotiveConfig[] {
  return [
    {
      id: 'reroll',
      icon: '🎲',
      label: m.workbench_reorganize_fresh_label(),
      sub: m.workbench_reorganize_fresh_sub(),
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_fresh_prompt(),
    },
    {
      id: 'untangle',
      icon: '🧹',
      label: m.workbench_reorganize_clarify_label(),
      sub: m.workbench_reorganize_clarify_sub(),
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_clarify_prompt(),
    },
    {
      id: 'compact',
      icon: '⚡',
      label: m.workbench_reorganize_fewer_label(),
      sub: m.workbench_reorganize_fewer_sub(),
      pacing: 'compact',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_fewer_prompt(),
    },
    {
      id: 'detailed',
      icon: '🔍',
      label: m.workbench_reorganize_more_label(),
      sub: m.workbench_reorganize_more_sub(),
      pacing: 'detailed',
      learnerArchetype: 'deep_dive_internals',
      basePrompt: m.workbench_reorganize_more_prompt(),
    },
  ];
}

export interface WorkbenchReorganizePanelProps {
  onClose: () => void;
  onReorganize?: (options: {
    customPrompt: string;
    pacing: 'compact' | 'normal' | 'detailed';
    learnerArchetype?: LearnerArchetype;
  }) => void;
}

export function WorkbenchReorganizePanel({ onClose, onReorganize }: WorkbenchReorganizePanelProps) {
  const storePrompt = useImportWizardStore((s) => s.customPrompt);
  const [selectedMotive, setSelectedMotive] = useState<ReorganizeMotive>('reroll');
  const [customInput, setCustomInput] = useState('');
  const motives = useMemo(() => getReorganizeMotives(), []);

  useEffect(() => {
    if (storePrompt && !motives.some((m) => m.basePrompt === storePrompt)) {
      setCustomInput(storePrompt);
    }
  }, [storePrompt, motives]);

  const handleApply = () => {
    const motive = motives.find((m) => m.id === selectedMotive) ?? motives[0];
    const trimmedInput = customInput.trim();
    const finalPrompt = trimmedInput
      ? `${motive.basePrompt}。补充要求：${trimmedInput}`
      : motive.basePrompt;

    wizardSetters.setCustomPrompt(finalPrompt);
    onClose();
    onReorganize?.({
      customPrompt: finalPrompt,
      pacing: motive.pacing,
      learnerArchetype: motive.learnerArchetype,
    });
  };

  return (
    <div className="bg-theme-surface/60 border border-theme-primary/30 rounded-xl p-3.5 mb-3 shadow-xs animate-in fade-in slide-in-from-top-2 duration-200 select-none shrink-0">
      {/* Title Bar */}
      <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-theme-border/40">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-theme-primary" />
          <span className="font-serif font-bold text-xs text-theme-foreground">
            {m.workbench_reorganize_title()}
          </span>
          <span className="text-micro text-theme-muted">
            {m.workbench_reorganize_desc()}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-theme-muted hover:text-theme-foreground p-1 rounded-md hover:bg-theme-surface transition-colors cursor-pointer"
          title={m.workbench_reorganize_collapse()}
        >
          <X size={14} />
        </button>
      </div>

      {/* 4 Core Motives Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        {motives.map((motive) => {
          const isSelected = selectedMotive === motive.id;
          return (
            <button
              key={motive.id}
              type="button"
              onClick={() => setSelectedMotive(motive.id)}
              className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between ${
                isSelected
                  ? 'border-theme-primary bg-theme-primary/10 text-theme-foreground shadow-2xs'
                  : 'border-theme-border/60 bg-theme-surface/40 hover:border-theme-border hover:bg-theme-surface/80 text-theme-muted hover:text-theme-foreground'
              }`}
            >
              <div className="flex items-center gap-1.5 font-serif font-bold text-xs">
                <span>{motive.icon}</span>
                <span className={isSelected ? 'text-theme-primary font-bold' : ''}>
                  {motive.label}
                </span>
              </div>
              <div className="text-micro text-theme-muted mt-1 leading-tight line-clamp-1">
                {motive.sub}
              </div>
            </button>
          );
        })}
      </div>

      {/* Input + Action Row */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleApply();
            }
          }}
          placeholder={m.workbench_reorganize_input_placeholder()}
          className="flex-1 text-xs font-sans bg-theme-bg/80 border border-theme-border/70 rounded-lg px-3 py-1.5 text-theme-foreground placeholder:text-theme-muted/50 focus:outline-none focus:border-theme-primary transition-all"
        />
        <button
          type="button"
          onClick={handleApply}
          className="px-3.5 py-1.5 bg-theme-primary text-theme-primary-fg font-serif font-bold text-xs rounded-lg shadow-sm hover:opacity-90 active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 cursor-pointer"
        >
          <Sparkles size={13} />
          <span>{m.workbench_reorganize_submit()}</span>
        </button>
      </div>
    </div>
  );
}
