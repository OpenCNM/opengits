'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Shuffle, Sparkles, Trash2, X } from 'lucide-react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import {
  loadReorganizeCustom,
  removeReorganizeCustomItem,
  type SavedCustomItem,
} from '@/lib/import-wizard/reorganize-custom-storage';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';
import type { ReorganizeCategoryId } from '@/lib/constants';
import { ReorganizeCustomComposer } from './ReorganizeCustomComposer';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import {
  buildChapterSubOptions,
  getReorganizeCategories,
  getReorganizeMotives,
  type ReorganizeCategory,
  type ReorganizeOptions,
} from './workbench-reorganize-config';

interface WorkbenchReorganizeBarProps {
  onReorganize?: (options: ReorganizeOptions) => void;
  disabled?: boolean;
}

const EMPTY_SAVED_ITEMS: Record<ReorganizeCategoryId, SavedCustomItem[]> = {
  clarify: [],
  compact: [],
  expand: [],
};

const OPTION_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors border border-transparent hover:bg-theme-surface/80 cursor-pointer';

export function WorkbenchReorganizeBar({
  onReorganize,
  disabled = false,
}: WorkbenchReorganizeBarProps) {
  const storePrompt = useImportWizardStore((s) => s.customPrompt);
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const scoutData = useImportWizardStore((s) => s.scoutData);

  const motives = useMemo(() => getReorganizeMotives(), []);
  const categories = useMemo(() => getReorganizeCategories(), []);
  const chapterOptions = useMemo(
    () => buildChapterSubOptions(customOutline as WorkbenchOutlineCategory[]),
    [customOutline],
  );

  const primaryMotive = motives[0];
  const [reorgOpen, setReorgOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ReorganizeCategoryId>(
    () => categories[0]?.id ?? 'clarify',
  );
  const [savedItems, setSavedItems] = useState<Record<ReorganizeCategoryId, SavedCustomItem[]>>(
    EMPTY_SAVED_ITEMS,
  );

  const isCategoryActive = (category: ReorganizeCategory): boolean => {
    if (!storePrompt) return false;
    return (
      category.options.some((option) => option.payload.customPrompt === storePrompt) ||
      savedItems[category.id].some((saved) => saved.prompt === storePrompt) ||
      (category.id === 'expand' &&
        chapterOptions.some((option) => option.payload.customPrompt === storePrompt))
    );
  };

  const isReorganizeMatched = Boolean(
    storePrompt &&
      (storePrompt === primaryMotive.basePrompt || categories.some(isCategoryActive)),
  );
  const hasCustomActive = Boolean(storePrompt.trim()) && !isReorganizeMatched;

  const handleReorgOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    setReorgOpen(nextOpen);
    if (nextOpen) {
      setCustomOpen(false);
      const owner = scoutData?.owner;
      const repo = scoutData?.repo;
      const loaded = owner && repo ? loadReorganizeCustom(owner, repo) : EMPTY_SAVED_ITEMS;
      setSavedItems(loaded);
      const matchedCategory = categories.find((cat) =>
        cat.options.some((opt) => opt.payload.customPrompt === storePrompt) ||
        loaded[cat.id].some((saved) => saved.prompt === storePrompt) ||
        (cat.id === 'expand' &&
          chapterOptions.some((opt) => opt.payload.customPrompt === storePrompt))
      );
      if (matchedCategory) {
        setActiveTab(matchedCategory.id);
      }
    }
  };

  const handleCustomOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    setCustomOpen(nextOpen);
    if (nextOpen) {
      setReorgOpen(false);
    }
  };

  const activateOptions = (payload: ReorganizeOptions) => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(payload.customPrompt);
    onReorganize?.(payload);
    setReorgOpen(false);
  };

  const triggerPrimaryMotive = () => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(primaryMotive.basePrompt);
    onReorganize?.({
      customPrompt: primaryMotive.basePrompt,
      pacing: primaryMotive.pacing,
      learnerArchetype: primaryMotive.learnerArchetype,
    });
    setReorgOpen(false);
  };

  const handleDeleteSaved = (categoryId: ReorganizeCategoryId, itemId: string) => {
    if (disabled) return;
    const owner = scoutData?.owner;
    const repo = scoutData?.repo;
    if (!owner || !repo) return;
    removeReorganizeCustomItem(owner, repo, categoryId, itemId);
    setSavedItems(loadReorganizeCustom(owner, repo));
  };

  const handleCustomSubmit = (prompt: string) => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(prompt);
    onReorganize?.({
      customPrompt: prompt,
    });
    setCustomOpen(false);
  };

  const activeCategory = categories.find((c) => c.id === activeTab) ?? categories[0];
  const activeSaved = activeCategory ? savedItems[activeCategory.id] : [];
  const activeChapters = activeCategory?.id === 'expand' ? chapterOptions : [];

  return (
    <>
      {(reorgOpen || customOpen) && (
        <div
          aria-hidden="true"
          onClick={() => {
            setReorgOpen(false);
            setCustomOpen(false);
          }}
          className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 cursor-pointer"
        />
      )}

      <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-theme-bg/70 border border-theme-border/60 select-none">
        <Popover open={customOpen} onOpenChange={handleCustomOpenChange}>
          <div
            className={`inline-flex items-center rounded-lg border transition-all shrink-0 ${
              hasCustomActive
                ? 'bg-theme-primary/15 text-theme-primary border-theme-primary/40 font-bold shadow-2xs'
                : customOpen
                  ? 'bg-theme-surface text-theme-foreground border-theme-border/70'
                  : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/70 border-transparent'
            }`}
          >
            <PopoverTrigger
              type="button"
              disabled={disabled}
              title={m.workbench_reorganize_custom_btn()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-serif cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Sparkles size={13} className="shrink-0 text-theme-primary" />
              <span>{m.workbench_reorganize_custom_btn()}</span>
            </PopoverTrigger>
            {hasCustomActive && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => wizardSetters.setCustomPrompt('')}
                aria-label={m.common_delete()}
                className="pr-2 pl-0.5 py-1.5 text-theme-primary/70 hover:text-theme-primary cursor-pointer disabled:opacity-40"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <PopoverPopup
            side="top"
            align="end"
            sideOffset={8}
            viewportClassName="p-3.5"
            className="w-[340px] sm:w-[380px] bg-theme-bg border border-theme-border rounded-xl shadow-xl z-[250]"
          >
            <div className="space-y-2.5">
              <div className="text-xs font-serif font-semibold text-theme-foreground">
                {m.workbench_reorganize_custom_btn()}
              </div>
              <ReorganizeCustomComposer
                initialInput={hasCustomActive ? storePrompt : ''}
                onSubmit={handleCustomSubmit}
              />
            </div>
          </PopoverPopup>
        </Popover>

        <Popover open={reorgOpen} onOpenChange={handleReorgOpenChange}>
          <div
            className={`inline-flex items-center rounded-lg border transition-all shrink-0 ${
              isReorganizeMatched
                ? 'bg-theme-primary/15 text-theme-primary border-theme-primary/40 font-bold shadow-2xs'
                : reorgOpen
                  ? 'bg-theme-surface text-theme-foreground border-theme-border/70'
                  : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/70 border-transparent'
            }`}
          >
            <PopoverTrigger
              type="button"
              disabled={disabled}
              title={primaryMotive.sub}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-serif cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Shuffle size={13} className="shrink-0" />
              <span>{primaryMotive.label}</span>
              <ChevronDown size={11} className="shrink-0 opacity-70" />
            </PopoverTrigger>
            {isReorganizeMatched && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => wizardSetters.setCustomPrompt('')}
                aria-label={m.common_delete()}
                className="pr-2 pl-0.5 py-1.5 text-theme-primary/70 hover:text-theme-primary cursor-pointer disabled:opacity-40"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <PopoverPopup
            side="top"
            align="end"
            sideOffset={8}
            viewportClassName="p-3"
            className="w-[330px] sm:w-[360px] bg-theme-bg border border-theme-border rounded-xl shadow-xl z-[250]"
          >
            <div className="space-y-3">
              <button
                type="button"
                onClick={triggerPrimaryMotive}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left ${
                  storePrompt === primaryMotive.basePrompt
                    ? 'border-theme-primary/50 bg-theme-primary/10 text-theme-primary'
                    : 'border-theme-border/60 bg-theme-surface/40 hover:bg-theme-surface text-theme-foreground'
                }`}
              >
                <Shuffle size={14} className="shrink-0 text-theme-primary" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs font-serif font-semibold truncate">
                    {primaryMotive.label}
                  </div>
                  <div className="text-caption text-theme-muted truncate">
                    {primaryMotive.sub}
                  </div>
                </div>
              </button>

              <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-theme-surface/60 border border-theme-border/50">
                {categories.map((cat) => {
                  const isTab = cat.id === activeTab;
                  const isCatActive = isCategoryActive(cat);
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveTab(cat.id)}
                      className={`px-2 py-1.5 text-xs font-sans rounded-md transition-all cursor-pointer truncate flex items-center justify-center gap-1 ${
                        isTab
                          ? 'bg-theme-bg text-theme-foreground font-semibold shadow-2xs border border-theme-border/60'
                          : 'text-theme-muted hover:text-theme-foreground'
                      }`}
                    >
                      <span>{cat.label}</span>
                      {isCatActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-theme-primary shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>

              {activeCategory && (
                <div className="space-y-1 max-h-56 overflow-y-auto custom-scrollbar pr-0.5">
                  {activeCategory.options.map((option) => {
                    const isSelected = storePrompt === option.payload.customPrompt;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => activateOptions(option.payload)}
                        className={`${OPTION_ROW_CLASS} ${
                          isSelected
                            ? 'bg-theme-primary/10 border-theme-primary/30 text-theme-primary'
                            : 'text-theme-foreground'
                        }`}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="text-xs font-medium truncate">{option.label}</div>
                          {option.hint && (
                            <div className="text-caption text-theme-muted truncate">{option.hint}</div>
                          )}
                        </div>
                      </button>
                    );
                  })}

                  {activeSaved.map((item) => {
                    const isSelected = storePrompt === item.prompt;
                    return (
                      <div
                        key={item.id}
                        className={`${OPTION_ROW_CLASS} group ${
                          isSelected
                            ? 'bg-theme-primary/10 border-theme-primary/30 text-theme-primary'
                            : 'text-theme-foreground'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            activateOptions({
                              customPrompt: item.prompt,
                              pacing: item.pacing,
                              learnerArchetype: item.learnerArchetype,
                            })
                          }
                          className="min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <div className="text-xs font-medium truncate">{item.label}</div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSaved(activeCategory.id, item.id);
                          }}
                          aria-label={m.common_delete()}
                          className="p-1 text-theme-muted hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}

                  {activeChapters.length > 0 && (
                    <div className="pt-1.5 mt-1.5 border-t border-theme-border/40 space-y-1">
                      {activeChapters.map((ch) => {
                        const isSelected = storePrompt === ch.payload.customPrompt;
                        return (
                          <button
                            key={ch.id}
                            type="button"
                            onClick={() => activateOptions(ch.payload)}
                            className={`${OPTION_ROW_CLASS} ${
                              isSelected
                                ? 'bg-theme-primary/10 border-theme-primary/30 text-theme-primary'
                                : 'text-theme-foreground'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-xs truncate">{ch.label}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </>
  );
}
