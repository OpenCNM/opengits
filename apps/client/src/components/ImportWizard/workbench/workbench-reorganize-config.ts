import {
  REORGANIZE_ARCHETYPE_IDS,
  REORGANIZE_CATEGORY_IDS,
  REORGANIZE_CHAPTER_OPTIONS_MAX,
  REORGANIZE_PACING_IDS,
  type ReorganizeCategoryId,
  type ReorganizeLearnerArchetype,
  type ReorganizePacing,
} from '@/lib/constants';
import * as m from '@/paraglide/messages';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';

const CHAPTER_PROMPT_FILES_MAX = 3;

export const REORGANIZE_PACING_FREEZE = [
  'compact',
  'normal',
  'detailed',
] as const satisfies typeof REORGANIZE_PACING_IDS;

export const REORGANIZE_ARCHETYPE_FREEZE = [
  'architecture_overview',
  'deep_dive_internals',
  'cross_language_migrant',
  'pedagogical_beginner',
] as const satisfies typeof REORGANIZE_ARCHETYPE_IDS;

export type LearnerArchetype = ReorganizeLearnerArchetype;

export type ReorganizeMotive = 'reroll' | 'untangle' | 'compact' | 'detailed';

interface MotiveConfig {
  id: ReorganizeMotive;
  icon: string;
  label: string;
  sub: string;
  pacing: ReorganizePacing;
  learnerArchetype: LearnerArchetype;
  basePrompt: string;
}

export interface ReorganizeOptions {
  customPrompt: string;
  pacing?: ReorganizePacing;
  learnerArchetype?: LearnerArchetype;
}

export type ReorganizeSubOptionKind = 'preset' | 'chapter' | 'custom';

export interface ReorganizeSubOption {
  id: string;
  label: string;
  hint?: string;
  kind: ReorganizeSubOptionKind;
  payload: ReorganizeOptions;
}

export interface ReorganizeCategory {
  id: ReorganizeCategoryId;
  label: string;
  sub: string;
  options: ReorganizeSubOption[];
}

export function getReorganizeMotives(): MotiveConfig[] {
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

export function getReorganizeCategories(): ReorganizeCategory[] {
  const matrix: Record<
    ReorganizeCategoryId,
    { label: string; sub: string; options: ReorganizeSubOption[] }
  > = {
    clarify: {
      label: m.workbench_reorganize_clarify_label(),
      sub: m.workbench_reorganize_clarify_sub(),
      options: [
        {
          id: 'by_call_chain',
          label: m.workbench_reorganize_opt_by_call_chain(),
          hint: m.workbench_reorganize_opt_by_call_chain_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_call_chain_prompt(),
            pacing: 'normal',
            learnerArchetype: 'deep_dive_internals',
          },
        },
        {
          id: 'by_layers',
          label: m.workbench_reorganize_opt_by_layers(),
          hint: m.workbench_reorganize_opt_by_layers_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_layers_prompt(),
            pacing: 'normal',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'by_module',
          label: m.workbench_reorganize_opt_by_module(),
          hint: m.workbench_reorganize_opt_by_module_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_module_prompt(),
            pacing: 'normal',
            learnerArchetype: 'architecture_overview',
          },
        },
      ],
    },
    compact: {
      label: m.workbench_reorganize_fewer_label(),
      sub: m.workbench_reorganize_fewer_sub(),
      options: [
        {
          id: 'minimal_backbone',
          label: m.workbench_reorganize_opt_minimal_backbone(),
          hint: m.workbench_reorganize_opt_minimal_backbone_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_minimal_backbone_prompt(),
            pacing: 'compact',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'standard_refine',
          label: m.workbench_reorganize_opt_standard_refine(),
          hint: m.workbench_reorganize_opt_standard_refine_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_fewer_prompt(),
            pacing: 'compact',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'skip_basics',
          label: m.workbench_reorganize_opt_skip_basics(),
          hint: m.workbench_reorganize_opt_skip_basics_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_skip_basics_prompt(),
            pacing: 'compact',
            learnerArchetype: 'cross_language_migrant',
          },
        },
      ],
    },
    expand: {
      label: m.workbench_reorganize_more_label(),
      sub: m.workbench_reorganize_more_sub(),
      options: [
        {
          id: 'deep_source',
          label: m.workbench_reorganize_opt_deep_source(),
          hint: m.workbench_reorganize_opt_deep_source_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_more_prompt(),
            pacing: 'detailed',
            learnerArchetype: 'deep_dive_internals',
          },
        },
        {
          id: 'patterns_boundaries',
          label: m.workbench_reorganize_opt_patterns_boundaries(),
          hint: m.workbench_reorganize_opt_patterns_boundaries_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_patterns_boundaries_prompt(),
            pacing: 'detailed',
            learnerArchetype: 'deep_dive_internals',
          },
        },
      ],
    },
  };

  return REORGANIZE_CATEGORY_IDS.map((id) => ({ id, ...matrix[id] }));
}

export function buildChapterSubOptions(
  outline: WorkbenchOutlineCategory[],
): ReorganizeSubOption[] {
  const ranked = outline
    .map((cat, index) => ({
      cat,
      index,
      title: (cat.title || cat.name || '').trim(),
      fileCount: cat.files?.length ?? 0,
    }))
    .filter((entry) => entry.title.length > 0)
    .sort((a, b) => b.fileCount - a.fileCount || a.index - b.index)
    .slice(0, REORGANIZE_CHAPTER_OPTIONS_MAX);

  return ranked.map((entry, rankIndex) => {
    const { cat, title } = entry;
    const files = (cat.files ?? [])
      .map((file) => file.path || file.shortTitle || '')
      .filter(Boolean)
      .slice(0, CHAPTER_PROMPT_FILES_MAX)
      .join(', ');

    const option: ReorganizeSubOption = {
      id: `chapter-${rankIndex}`,
      label: title,
      kind: 'chapter',
      payload: {
        customPrompt: files
          ? m.workbench_reorganize_opt_chapter_prompt({ title, files })
          : m.workbench_reorganize_opt_chapter_prompt_nofiles({ title }),
        pacing: 'normal',
        learnerArchetype: 'deep_dive_internals',
      },
    };
    return option;
  });
}
