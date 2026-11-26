import { z } from 'zod';
import { sanitizePromptText } from './prompt-safety';
import { renderPresetDirective } from './prompt-presets';

import type { TeachingDepth } from './llm-gateway/registry';

// Must remain browser-safe with zero server dependencies for ImportWizard.

export interface TranscriptionPreset {
  id: string;
  name: string;
  description: string;
  directive: string;
  icon: 'graduation-cap' | 'microscope' | 'list-checks' | 'book-marked' | 'arrow-left-right' | 'layers';
  toneClass: string;
  defaults?: {
    teachingDepth?: TeachingDepth;
    aiCondensation?: string;
  };
}

export const TRANSCRIPTION_PRESETS: readonly TranscriptionPreset[] = [
  {
    id: 'standard',
    name: '教学解读',
    description: '渐进式讲解：先讲设计动机再给代码证据，标注关键设计决策',
    directive: renderPresetDirective('transcription_style_standard'),
    icon: 'graduation-cap',
    toneClass: 'text-sky-600 bg-sky-500/10 border-sky-500/30',
    defaults: { teachingDepth: 'standard', aiCondensation: 'balanced' },
  },
  {
    id: 'deep',
    name: '深度剖析',
    description: '深究核心机制：结合真实源码剖析边界与权衡，实现清单收入深潜折叠区',
    directive: renderPresetDirective('transcription_style_deep'),
    icon: 'microscope',
    toneClass: 'text-violet-600 bg-violet-500/10 border-violet-500/30',
    defaults: { teachingDepth: 'deep' },
  },
  {
    id: 'cheatsheet',
    name: '速查手册',
    description: '查表优先：API 表格 + 极简要点，为快速检索优化',
    directive: renderPresetDirective('transcription_style_cheatsheet'),
    icon: 'list-checks',
    toneClass: 'text-amber-600 bg-amber-500/10 border-amber-500/30',
    defaults: { aiCondensation: 'tldr' },
  },
  {
    id: 'faithful',
    name: '忠实原文',
    description: '只修排版不改写：保留原文措辞与结构',
    directive: renderPresetDirective('transcription_style_faithful'),
    icon: 'book-marked',
    toneClass: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/30',
    defaults: { aiCondensation: 'faithful' },
  },
  {
    id: 'analogy',
    name: '类比桥接',
    description: '以你熟悉的技术为锚点对照讲解（在下方指令里写明你的技术背景）',
    directive: renderPresetDirective('transcription_style_analogy'),
    icon: 'arrow-left-right',
    toneClass: 'text-rose-600 bg-rose-500/10 border-rose-500/30',
  },
];

export const DEFAULT_TRANSCRIPTION_PRESET_ID = 'standard';

const transcriptionPresetIdSchema = z.enum(
  TRANSCRIPTION_PRESETS.map((p) => p.id) as [string, ...string[]],
);

const CUSTOM_PROMPT_MAX_CHARS = 2000;

export function resolveTranscriptionPreset(id?: string | null): TranscriptionPreset {
  const parsed = typeof id === 'string' ? transcriptionPresetIdSchema.safeParse(id) : null;
  const key = parsed?.success ? parsed.data : DEFAULT_TRANSCRIPTION_PRESET_ID;
  return TRANSCRIPTION_PRESETS.find((p) => p.id === key) ?? TRANSCRIPTION_PRESETS[0];
}

export function buildStyleDirective(presetId?: string | null, customPrompt?: string | null): string {
  const preset = resolveTranscriptionPreset(presetId);
  const parts: string[] = [];
  if (preset.directive) {
    parts.push(preset.directive);
  }
  const trimmed = (customPrompt || '').trim();
  if (trimmed) {
    parts.push(`USER CUSTOM INSTRUCTION: ${sanitizePromptText(trimmed.slice(0, CUSTOM_PROMPT_MAX_CHARS))}`);
  }
  return parts.join('\n');
}
