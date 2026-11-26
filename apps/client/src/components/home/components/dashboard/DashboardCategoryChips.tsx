'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { KNOWN_CATEGORY_LABELS, normalizeCategory } from '@/lib/constants';
import * as m from '@/paraglide/messages';

const CATEGORY_I18N: Record<string, () => string> = {
  'AI': () => m.category_ai_ml(),
  'Systems': () => m.category_systems(),
  'Cloud': () => m.category_cloud(),
  'Web': () => m.category_web(),
  'Mobile': () => m.category_mobile(),
  'Gaming': () => m.category_gaming(),
  'Hardware': () => m.category_hardware(),
  'Finance': () => m.category_finance(),
  'Science': () => m.category_science(),
  'Frontend': () => m.category_frontend(),
  'Backend': () => m.category_backend(),
  'Database': () => m.category_database(),
  'DevOps': () => m.category_devops(),
  'Computer Science': () => m.category_cs(),
  'Web Docs': () => m.category_web_docs(),
  'Others': () => m.category_others(),
};

export function getLocalizedCategory(cat: string): string {
  if (cat === 'all') return m.category_all();
  const normalized = normalizeCategory(cat);
  const localized = CATEGORY_I18N[normalized];
  if (localized) return localized();
  return KNOWN_CATEGORY_LABELS[normalized] || KNOWN_CATEGORY_LABELS[cat] || cat;
}

interface DashboardCategoryChipsProps {
  categories: string[];
  selectedCategory: string;
  onSelectCategory: (cat: string) => void;
}

export function DashboardCategoryChips({ categories, selectedCategory, onSelectCategory }: DashboardCategoryChipsProps) {
  const effectiveCategories = React.useMemo(() => {
    if (selectedCategory && selectedCategory !== 'all' && !categories.includes(selectedCategory)) {
      return [...categories, selectedCategory];
    }
    return categories;
  }, [categories, selectedCategory]);

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar text-xs font-sans pr-1 scroll-smooth min-w-0 flex-1 py-0.5">
      {effectiveCategories.map((cat) => {
        const isSelected = selectedCategory === cat;
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onSelectCategory(isSelected ? 'all' : cat)}
            className={`relative inline-flex items-center gap-1 px-2.5 py-1 rounded-md shrink-0 cursor-pointer text-xs transition-colors select-none ${
              isSelected
                ? 'bg-theme-primary text-theme-primary-fg font-medium'
                : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80'
            }`}
            title={isSelected ? m.category_chip_deselect_hint() : undefined}
          >
            <span>{getLocalizedCategory(cat)}</span>
            {isSelected && cat !== 'all' && (
              <X className="w-3 h-3 ml-0.5 opacity-70 hover:opacity-100" />
            )}
          </button>
        );
      })}
    </div>
  );
}
